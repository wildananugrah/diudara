import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { CommunityDraft } from "@diudara/shared";
import { apiFetch, apiRequest, DashboardApiError } from "../apiClient";
import { billingCycleLabel, formatRupiah } from "../format";
import { EmptyState, ErrorPanel, Field } from "../ui";
import { useLoad } from "../useLoad";
import type { AiMessageResult, AiStatus, Community, Tier } from "../types";

/**
 * The AI co-builder chat (Phase 7 Task 7): a Bahasa Indonesia conversation that
 * ends with a pre-filled, EDITABLE community draft the creator saves through the
 * same two endpoints the manual flow uses.
 *
 * WHY THIS SCREEN NEVER INVENTS ITS OWN WRITE PATH (design ruling #2): saving
 * calls `POST /communities` and then `POST /communities/:id/tiers` — exactly
 * `CommunitiesPage`'s `CreateCommunityForm` and `TiersPage`'s `CreateTierForm`.
 * Every rule those endpoints enforce (name/niche bounds, integer Rupiah, the
 * three billing cycles) is enforced here too, for free, because it is the same
 * request. `description` and `welcomeMessage` never appear in either request
 * body — `community` has no columns for them — so they are shown, copyable, and
 * explicitly labelled "not stored" rather than silently dropped (ruling #1).
 */

type ChatRole = "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface DraftTierForm {
  name: string;
  /** Raw text as typed — parsed the same way `TiersPage`'s price field is. */
  price: string;
  billingCycle: string;
  status: "pending" | "creating" | "created" | "failed";
  error?: string;
  tierId?: string;
}

interface DraftFormState {
  name: string;
  niche: string;
  description: string;
  welcomeMessage: string;
  tiers: DraftTierForm[];
}

type SaveState =
  | { kind: "idle" }
  | { kind: "creating_community" }
  | { kind: "community_error"; message: string }
  | { kind: "saved"; community: Community };

type SendErrorKind = "rate_limit" | "not_found" | "provider" | "generic";

interface SendErrorState {
  kind: SendErrorKind;
  message: string;
}

/**
 * The 429 body's typed half — see `RateLimitedError` (apps/api/src/application/errors.ts).
 * `message` already carries the Indonesian sentence with the Jakarta-local reset
 * time baked in by the API; `resetAt` is kept on the error for any caller that
 * wants the raw instant, even though this screen only ever renders `message`.
 */
class AiRateLimitedError extends Error {
  constructor(message: string, readonly resetAt: string) {
    super(message);
    this.name = "AiRateLimitedError";
  }
}

/**
 * `POST /ai/messages`, with its OWN error handling rather than the shared
 * `apiFetch` — this endpoint's 429 carries a machine-readable `resetAt`
 * alongside `error`, which `apiFetch`'s generic `readError` throws away (it
 * only ever keeps `error`). Built on `apiRequest` (not `apiFetch`) so the 401
 * interceptor still applies unmodified.
 */
async function sendAiMessage(input: {
  conversationId: string | null;
  content: string;
}): Promise<AiMessageResult> {
  const res = await apiRequest("/ai/messages", {
    method: "POST",
    body: JSON.stringify({ conversationId: input.conversationId, content: input.content }),
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; resetAt?: string };
    throw new AiRateLimitedError(
      typeof body.error === "string" && body.error.length > 0
        ? body.error
        : "Batas harian AI co-builder sudah tercapai.",
      typeof body.resetAt === "string" ? body.resetAt : new Date().toISOString()
    );
  }

  if (!res.ok) {
    let message = `permintaan gagal (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    } catch {
      // Not JSON — keep the fallback.
    }
    throw new DashboardApiError(message, res.status);
  }

  return (await res.json()) as AiMessageResult;
}

/**
 * Turns a failed `sendAiMessage` call into the four DISTINCT outcomes the
 * plan requires: the daily cap (429), an unknown/foreign conversation (404),
 * a provider failure (502/503), or anything else. Never a generic panel for
 * the first three.
 */
function classifySendError(err: unknown): SendErrorState {
  if (err instanceof AiRateLimitedError) {
    return { kind: "rate_limit", message: err.message };
  }
  if (err instanceof DashboardApiError) {
    if (err.status === 404) {
      return {
        kind: "not_found",
        message: "Percakapan ini sudah tidak ada. Kirim pesan Anda lagi untuk memulai yang baru.",
      };
    }
    if (err.status === 502 || err.status === 503) {
      return { kind: "provider", message: err.message };
    }
    return { kind: "generic", message: err.message };
  }
  return { kind: "generic", message: "Tidak dapat menghubungi server. Coba lagi." };
}

function sendErrorTitle(kind: SendErrorKind): string {
  switch (kind) {
    case "rate_limit":
      return "Anda sudah mencapai batas harian";
    case "not_found":
      return "Percakapan tidak ditemukan";
    case "provider":
      return "AI co-builder tidak bisa merespons";
    default:
      return "Gagal mengirim pesan";
  }
}

/**
 * PRICES ARE INTEGER RUPIAH — duplicated from `TiersPage.tsx`'s
 * `parseRupiahInput` ON PURPOSE rather than imported: this is a second,
 * independent form enforcing the same "money never becomes a float" rule
 * `createTierSchema` enforces server-side, same precedent as
 * `ChannelsPage.tsx`'s duplicated Telegram chat-id regex. If the server's
 * rule ever changes, the server still wins — this only fails in the safe
 * direction (over-strict).
 */
function parseRupiahInput(raw: string): { amount: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Harga wajib diisi." };
  if (/[.,]\d{1,2}$/.test(trimmed) && /[,]/.test(trimmed)) {
    return { error: "Harga harus bilangan bulat Rupiah, tanpa desimal." };
  }
  const digits = trimmed.replace(/\./g, "");
  if (!/^\d+$/.test(digits)) {
    return { error: "Harga harus bilangan bulat Rupiah (hanya angka), misalnya 1250000." };
  }
  const amount = Number(digits);
  if (!Number.isSafeInteger(amount)) {
    return { error: "Harga harus bilangan bulat Rupiah." };
  }
  return { amount };
}

function toDraftForm(draft: CommunityDraft): DraftFormState {
  return {
    name: draft.name,
    niche: draft.niche,
    description: draft.description,
    welcomeMessage: draft.welcomeMessage,
    tiers: draft.tiers.map((tier) => ({
      name: tier.name,
      price: String(tier.priceAmount),
      billingCycle: tier.billingCycle,
      status: "pending",
    })),
  };
}

function updateTierAt(form: DraftFormState, index: number, patch: Partial<DraftTierForm>): DraftFormState {
  return { ...form, tiers: form.tiers.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)) };
}

export default function CoBuilderPage() {
  const [statusLoad, statusHandle] = useLoad(() => apiFetch<AiStatus>("/ai/status"), []);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<SendErrorState | null>(null);

  const [draftForm, setDraftForm] = useState<DraftFormState | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  async function handleSend(event?: FormEvent) {
    event?.preventDefault();
    const text = content.trim();
    if (text === "" || sending) return;

    setSending(true);
    setSendError(null);
    try {
      const result = await sendAiMessage({ conversationId, content: text });
      setConversationId(result.conversationId);
      setMessages((prev) => [
        ...prev,
        { role: "user", content: text },
        { role: "assistant", content: result.reply },
      ]);
      // Cleared only on success — a failed send leaves what was typed exactly
      // where the creator left it (plan: "the creator's typed message is not
      // lost").
      setContent("");
      if (result.draft !== null) {
        setDraftForm(toDraftForm(result.draft));
        setSaveState({ kind: "idle" });
      }
    } catch (err) {
      const classified = classifySendError(err);
      if (classified.kind === "not_found") {
        // The id this conversation was tracking no longer resolves; the next
        // attempt (the same "Coba lagi" button) starts a fresh conversation
        // rather than repeating the 404 forever.
        setConversationId(null);
      }
      setSendError(classified);
    } finally {
      setSending(false);
    }
  }

  function updateDraftField(field: "name" | "niche" | "description" | "welcomeMessage", value: string) {
    setDraftForm((prev) => (prev === null ? prev : { ...prev, [field]: value }));
  }

  function updateTierField(index: number, patch: Partial<Pick<DraftTierForm, "name" | "price">>) {
    setDraftForm((prev) => (prev === null ? prev : updateTierAt(prev, index, { ...patch, error: undefined })));
  }

  /** Runs `POST /communities/:id/tiers` for each of `indices`, in order, recording each one's own outcome. */
  async function runTierAttempts(
    communityId: string,
    indices: number[],
    parsedByIndex: ReadonlyMap<number, { name: string; priceAmount: number; billingCycle: string }>
  ) {
    for (const index of indices) {
      const parsed = parsedByIndex.get(index);
      if (parsed === undefined) continue;
      setDraftForm((prev) => (prev === null ? prev : updateTierAt(prev, index, { status: "creating" })));
      try {
        const created = await apiFetch<Tier>(`/communities/${communityId}/tiers`, {
          method: "POST",
          body: JSON.stringify(parsed),
        });
        setDraftForm((prev) =>
          prev === null ? prev : updateTierAt(prev, index, { status: "created", tierId: created.id, error: undefined })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Gagal menyimpan paket.";
        setDraftForm((prev) => (prev === null ? prev : updateTierAt(prev, index, { status: "failed", error: message })));
      }
    }
  }

  /**
   * `POST /communities` then `POST .../tiers` for every tier — THE ONLY WRITE
   * PATH this screen has (ruling #2). Every tier is validated locally first,
   * same rule and same message as `TiersPage`'s `parseRupiahInput`, so an
   * obviously-bad price never even reaches the network.
   */
  async function saveCommunity() {
    if (draftForm === null || saveState.kind !== "idle") return;

    const trimmedName = draftForm.name.trim();
    const trimmedNiche = draftForm.niche.trim();

    let hasFieldError = false;
    const parsedByIndex = new Map<number, { name: string; priceAmount: number; billingCycle: string }>();
    const validatedTiers = draftForm.tiers.map((tier, index) => {
      const name = tier.name.trim();
      if (name === "") {
        hasFieldError = true;
        return { ...tier, error: "Nama paket wajib diisi." };
      }
      const parsed = parseRupiahInput(tier.price);
      if ("error" in parsed) {
        hasFieldError = true;
        return { ...tier, error: parsed.error };
      }
      parsedByIndex.set(index, { name, priceAmount: parsed.amount, billingCycle: tier.billingCycle });
      return { ...tier, error: undefined };
    });

    if (trimmedName === "") {
      setSaveState({ kind: "community_error", message: "Nama komunitas wajib diisi." });
      return;
    }
    if (hasFieldError) {
      // No request at all — mirrors CreateTierForm: money never becomes a
      // float (or a blank name) on the way to the API.
      setDraftForm({ ...draftForm, tiers: validatedTiers });
      return;
    }

    setDraftForm({ ...draftForm, tiers: validatedTiers });
    setSaveState({ kind: "creating_community" });

    let community: Community;
    try {
      community = await apiFetch<Community>("/communities", {
        method: "POST",
        body: JSON.stringify({ name: trimmedName, ...(trimmedNiche === "" ? {} : { niche: trimmedNiche }) }),
      });
    } catch (err) {
      setSaveState({
        kind: "community_error",
        message: err instanceof Error ? err.message : "Tidak dapat menghubungi server. Coba lagi.",
      });
      return;
    }

    // The community exists now, no matter what happens to any tier below —
    // this state can never go back to "idle", so a tier failure can never
    // make this screen try to create the SAME community a second time.
    setSaveState({ kind: "saved", community });
    await runTierAttempts(
      community.id,
      validatedTiers.map((_, index) => index),
      parsedByIndex
    );
  }

  /**
   * Retries ONLY the tiers currently marked `"failed"`, using whatever the
   * creator has edited since — never the community (already created) and
   * never a tier already marked `"created"` (would duplicate it).
   */
  async function retryFailedTiers() {
    if (saveState.kind !== "saved" || draftForm === null) return;

    const failedIndices: number[] = [];
    let hasFieldError = false;
    const parsedByIndex = new Map<number, { name: string; priceAmount: number; billingCycle: string }>();

    const nextTiers = draftForm.tiers.map((tier, index) => {
      if (tier.status !== "failed") return tier;
      failedIndices.push(index);
      const name = tier.name.trim();
      if (name === "") {
        hasFieldError = true;
        return { ...tier, error: "Nama paket wajib diisi." };
      }
      const parsed = parseRupiahInput(tier.price);
      if ("error" in parsed) {
        hasFieldError = true;
        return { ...tier, error: parsed.error };
      }
      parsedByIndex.set(index, { name, priceAmount: parsed.amount, billingCycle: tier.billingCycle });
      return { ...tier, error: undefined };
    });

    if (failedIndices.length === 0) return;
    setDraftForm({ ...draftForm, tiers: nextTiers });
    if (hasFieldError) return;

    await runTierAttempts(saveState.community.id, failedIndices, parsedByIndex);
  }

  return (
    <section className="cobuilder">
      <h1>AI Co-Builder</h1>
      <p className="muted">
        Ceritakan komunitas yang ingin Anda buat, dalam Bahasa Indonesia. AI akan menyusun draf nama,
        bidang, deskripsi, pesan sambutan, dan paket keanggotaan — semuanya bisa Anda ubah sebelum
        disimpan.
      </p>

      {statusLoad.kind === "loading" ? <p className="muted">Memuat...</p> : null}
      {statusLoad.kind === "error" ? (
        <ErrorPanel message={statusLoad.message} onRetry={statusHandle.reload} />
      ) : null}

      {statusLoad.kind === "ready" && !statusLoad.data.enabled ? (
        <div className="card">
          <h2>Fitur AI Co-Builder belum aktif</h2>
          <p className="muted">
            Server ini belum dikonfigurasi untuk menggunakan AI co-builder. Anda tetap bisa membuat
            komunitas secara manual dari halaman Komunitas.
          </p>
          <Link to="/dashboard">Kembali ke daftar komunitas</Link>
        </div>
      ) : null}

      {statusLoad.kind === "ready" && statusLoad.data.enabled ? (
        <>
          <div className="chat-transcript" data-testid="chat-transcript" role="log" aria-live="polite">
            {messages.length === 0 ? (
              <EmptyState
                title="Mulai obrolan dengan AI Co-Builder"
                action={
                  'Ceritakan komunitas yang ingin Anda bangun, misalnya: “Saya mau bikin komunitas ' +
                  'belajar saham untuk pemula, dengan paket bulanan dan tahunan.”'
                }
              />
            ) : (
              messages.map((message, index) => (
                <div key={index} className={`chat-bubble chat-bubble-${message.role}`}>
                  {/* Model output is rendered as TEXT, never HTML — React text
                      interpolation, no dangerouslySetInnerHTML anywhere near it. */}
                  <p>{message.content}</p>
                </div>
              ))
            )}
            {sending ? (
              <p className="muted" data-testid="ai-thinking">
                AI sedang menyusun balasan...
              </p>
            ) : null}
          </div>

          {sendError !== null ? (
            <div className="notice notice-warning" role="alert" data-testid="send-error">
              <h3>{sendErrorTitle(sendError.kind)}</h3>
              <p>{sendError.message}</p>
              {sendError.kind !== "rate_limit" ? (
                <button type="button" className="button-secondary" onClick={() => handleSend()}>
                  Coba lagi
                </button>
              ) : null}
            </div>
          ) : null}

          <form onSubmit={handleSend} className="chat-composer">
            <textarea
              aria-label="Pesan Anda"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              disabled={sending}
              maxLength={4000}
              placeholder="Tulis pesan Anda di sini..."
            />
            <button type="submit" className="button-primary" disabled={sending || content.trim() === ""}>
              Kirim
            </button>
          </form>

          {draftForm !== null ? (
            <DraftPanel
              draftForm={draftForm}
              saveState={saveState}
              onChangeField={updateDraftField}
              onChangeTier={updateTierField}
              onSave={saveCommunity}
              onRetryFailedTiers={retryFailedTiers}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function DraftPanel({
  draftForm,
  saveState,
  onChangeField,
  onChangeTier,
  onSave,
  onRetryFailedTiers,
}: {
  draftForm: DraftFormState;
  saveState: SaveState;
  onChangeField: (field: "name" | "niche" | "description" | "welcomeMessage", value: string) => void;
  onChangeTier: (index: number, patch: Partial<Pick<DraftTierForm, "name" | "price">>) => void;
  onSave: () => void;
  onRetryFailedTiers: () => void;
}) {
  // Community-level fields lock the moment saving starts — there is nothing
  // left to edit once `POST /communities` has already gone out, since the
  // manual flow (CommunitiesPage) has no edit-in-place either.
  const locked = saveState.kind !== "idle";
  const anyTierFailed = draftForm.tiers.some((tier) => tier.status === "failed");

  return (
    <div className="card cobuilder-draft" data-testid="draft-panel">
      <h2>Draf komunitas</h2>
      <p className="hint">
        Semua isi di bawah ini bisa Anda ubah sebelum disimpan — AI bisa saja salah, terutama soal
        harga.
      </p>

      <div className="stack">
        <Field label="Nama komunitas" name="draft-name">
          <input
            id="field-draft-name"
            value={draftForm.name}
            disabled={locked}
            onChange={(event) => onChangeField("name", event.target.value)}
          />
        </Field>
        <Field label="Bidang" name="draft-niche" hint="Disimpan ke kolom bidang komunitas.">
          <input
            id="field-draft-niche"
            value={draftForm.niche}
            disabled={locked}
            onChange={(event) => onChangeField("niche", event.target.value)}
          />
        </Field>
        <Field
          label="Deskripsi"
          name="draft-description"
          hint="Tidak disimpan ke server — hanya ditampilkan di sini. Salin ke tempat lain jika ingin menyimpannya."
        >
          <textarea
            id="field-draft-description"
            value={draftForm.description}
            disabled={locked}
            onChange={(event) => onChangeField("description", event.target.value)}
          />
        </Field>
        <CopyButton text={draftForm.description} label="Salin deskripsi" />

        <Field
          label="Pesan sambutan"
          name="draft-welcome"
          hint="Tidak disimpan ke server — hanya ditampilkan di sini. Salin ke tempat lain jika ingin menyimpannya."
        >
          <textarea
            id="field-draft-welcome"
            value={draftForm.welcomeMessage}
            disabled={locked}
            onChange={(event) => onChangeField("welcomeMessage", event.target.value)}
          />
        </Field>
        <CopyButton text={draftForm.welcomeMessage} label="Salin pesan sambutan" />
      </div>

      <h3>Paket keanggotaan</h3>
      <div className="stack">
        {draftForm.tiers.map((tier, index) => (
          <TierRow
            key={index}
            index={index}
            tier={tier}
            // A tier already saved, or one whose save is in flight, is locked;
            // a FAILED tier stays editable so it can be fixed and retried.
            locked={locked && tier.status !== "failed"}
            onChange={onChangeTier}
          />
        ))}
      </div>

      {saveState.kind === "idle" ? (
        <button type="button" className="button-primary" onClick={onSave}>
          Buat komunitas ini
        </button>
      ) : null}

      {saveState.kind === "creating_community" ? <p className="muted">Menyimpan komunitas...</p> : null}

      {saveState.kind === "community_error" ? (
        <div className="form-error" role="alert">
          <p>{saveState.message}</p>
          <button type="button" className="button-secondary" onClick={onSave}>
            Coba lagi
          </button>
        </div>
      ) : null}

      {saveState.kind === "saved" ? (
        <div className="form-ok" data-testid="save-result">
          <p>
            Komunitas “{saveState.community.name}” berhasil dibuat.{" "}
            <Link to={`/dashboard/c/${saveState.community.id}`}>Lihat komunitas</Link>
          </p>
          {anyTierFailed ? (
            <>
              <p className="cell-warning">
                Sebagian paket gagal disimpan. Perbaiki di bawah lalu coba lagi, atau tambahkan
                secara manual di{" "}
                <Link to={`/dashboard/c/${saveState.community.id}/tiers`}>halaman Paket</Link>.
              </p>
              <button type="button" className="button-secondary" onClick={onRetryFailedTiers}>
                Coba lagi paket yang gagal
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TierRow({
  tier,
  index,
  locked,
  onChange,
}: {
  tier: DraftTierForm;
  index: number;
  locked: boolean;
  onChange: (index: number, patch: Partial<Pick<DraftTierForm, "name" | "price">>) => void;
}) {
  const parsedPrice = parseRupiahInput(tier.price);
  const priceHint =
    "error" in parsedPrice
      ? billingCycleLabel(tier.billingCycle)
      : `${formatRupiah(parsedPrice.amount)} ${billingCycleLabel(tier.billingCycle)}`;

  return (
    <div className="card" data-testid={`tier-row-${index}`}>
      <div className="inline-form">
        <Field label={`Nama paket ${index + 1}`} name={`tier-name-${index}`}>
          <input
            id={`field-tier-name-${index}`}
            value={tier.name}
            disabled={locked}
            onChange={(event) => onChange(index, { name: event.target.value })}
          />
        </Field>
        <Field
          label={`Harga paket ${index + 1} (Rupiah)`}
          name={`tier-price-${index}`}
          error={tier.error}
          hint={priceHint}
        >
          <input
            id={`field-tier-price-${index}`}
            value={tier.price}
            disabled={locked}
            inputMode="numeric"
            onChange={(event) => onChange(index, { price: event.target.value })}
          />
        </Field>
      </div>
      {tier.status === "created" ? <p className="muted">Sudah ditambahkan.</p> : null}
      {tier.status === "creating" ? <p className="muted">Menyimpan...</p> : null}
    </div>
  );
}

/**
 * "Salin teks ini" for a field with no persisted home — `description` and
 * `welcomeMessage` (ruling #1). Deliberately a plainer sibling of `ui.tsx`'s
 * `CopyableLink`: that component renders its own `<code>` box because the URL
 * it copies is not shown anywhere else, whereas this text is already visible
 * in the textarea right above the button.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div>
      <button type="button" className="button-secondary" onClick={copy}>
        {state === "copied" ? "Tersalin" : label}
      </button>
      {state === "failed" ? (
        <p className="hint">Tidak bisa menyalin otomatis — salin manual dari kotak di atas.</p>
      ) : null}
    </div>
  );
}
