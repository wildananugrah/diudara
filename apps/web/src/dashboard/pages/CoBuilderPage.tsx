import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { CommunityDraft } from "@diudara/shared";
import { apiFetch, apiRequest, DashboardApiError } from "../apiClient";
import { billingCycleLabel, billingCycleOptionLabel, formatRupiah } from "../format";
import { EmptyState, ErrorPanel, Field, PaymentAccountNotice } from "../ui";
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

/** Mirrors `TiersPage`'s own list — the enum `createTierSchema` accepts. */
const BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;

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
  /** Split by FIELD, the way `TiersPage`'s `CreateTierForm` splits `err.fieldErrors` —
   * a name problem must render under the name input, not the price one. */
  nameError?: string;
  priceError?: string;
  /** A failure that is not attributable to either field (a 500, a network error,
   * or a 400 whose message did not parse into `name`/`priceAmount`). */
  generalError?: string;
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
 * time baked in by the API, and that is the only half this screen ever needs —
 * so unlike the API's own type, this does not also carry a raw `resetAt`: an
 * unused field is worse than no field.
 */
class AiRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRateLimitedError";
  }
}

/**
 * `POST /ai/messages`, with its OWN error handling rather than the shared
 * `apiFetch` — this endpoint's 429 body's `error` is the one thing this
 * screen renders, and reading it here (rather than through `apiFetch`'s
 * generic `readError`) keeps that reading local to the one place it matters.
 * Built on `apiRequest` (not `apiFetch`) so the 401 interceptor still applies
 * unmodified.
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
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AiRateLimitedError(
      typeof body.error === "string" && body.error.length > 0
        ? body.error
        : "Batas harian AI co-builder sudah tercapai."
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

/** Splits a failed tier POST into the SAME per-field shape `TiersPage`'s `CreateTierForm` uses. */
function tierErrorPatch(err: unknown): Pick<DraftTierForm, "nameError" | "priceError" | "generalError"> {
  if (err instanceof DashboardApiError) {
    const nameError = err.fieldErrors.name;
    const priceError = err.fieldErrors.priceAmount;
    if (nameError !== undefined || priceError !== undefined) {
      return { nameError, priceError, generalError: undefined };
    }
    return { nameError: undefined, priceError: undefined, generalError: err.message };
  }
  return {
    nameError: undefined,
    priceError: undefined,
    generalError: err instanceof Error ? err.message : "Gagal menyimpan paket.",
  };
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
  /**
   * STICKY for the rest of this conversation, once set — never cleared by a
   * later draft arriving. This is what stops a follow-up ("ubah harga Pro
   * jadi 200rb", which the system prompt has the model answer with a FRESH
   * full draft) from quietly producing a second community: as long as this
   * is non-null, the panel for any LATER draft refuses to offer a plain
   * "Buat komunitas ini" — see the duplicate-risk notice in `DraftPanel`.
   */
  const [createdCommunity, setCreatedCommunity] = useState<Community | null>(null);
  /** Explicit opt-in for "yes, I mean to create a SECOND community" — reset on every new draft. */
  const [confirmSeparateCommunity, setConfirmSeparateCommunity] = useState(false);
  /**
   * Tier names STICKILY known to be missing from a community this
   * conversation created — captured the moment a later draft is about to
   * replace the panel that created it (see `handleSend`), because that is
   * the one moment the information would otherwise vanish: `retryFailedTiers`'s
   * own UI disappears with the panel, and nothing else on screen would ever
   * again say "Pro was never created".
   *
   * Paired with the id of the community it is ABOUT, not just left as a bare
   * name list — `createdCommunity` is overwritten unconditionally by every
   * later save (see its own docstring), so a bare list would silently keep
   * pointing at whichever community happens to be shown now. Community 1
   * saves with "Pro" failing, then community 2 (a deliberate SECOND
   * community, ticked via "simpan sebagai komunitas KEDUA") saves with every
   * tier succeeding: without the id, the notice would render under
   * `createdCommunity` (now community 2) and falsely claim community 2 is
   * missing "Pro", while community 1 — which really is missing it — is named
   * nowhere. The render site below only shows this when the id matches the
   * community currently displayed.
   */
  const [outstandingTiers, setOutstandingTiers] = useState<{ communityId: string; names: string[] } | null>(null);
  /**
   * A save (community + its tiers) is in flight. Disables the composer (see
   * the ruling: a UI lock alone is not the fix, but it IS required) and is
   * the second half of the defence against the race below.
   */
  const [saveInFlight, setSaveInFlight] = useState(false);

  /**
   * THE DRAFT GENERATION COUNTER — same pattern as `paymentAccount.ts`'s
   * `generation`, applied to the same problem: an async write landing after
   * the thing it was about must no longer apply.
   *
   * A `useRef`, not `useState`: nothing should ever re-render because this
   * changed, and every reader needs the CURRENT value synchronously inside an
   * async closure, never a value captured at the top of some earlier render.
   * Bumped exactly once, in `handleSend`, at the instant a NEW non-null draft
   * is about to replace `draftForm`. `saveCommunity`/`retryFailedTiers` each
   * capture the value at their own start and re-check it after every `await`
   * before writing `draftForm` or `saveState` — a mismatch means the draft (or
   * community) that write was about is gone, and the write is silently
   * dropped instead of landing on whatever draft happens to occupy the same
   * tier INDEX now.
   *
   * MEASURED: without this, sending a follow-up while a save's tier requests
   * are still in flight let the old save's `status`/error writes land on the
   * brand-new draft that had just replaced it — a tier the creator never even
   * saw showing "Sudah ditambahkan." or a stale price error, and the OLD
   * community's "berhasil dibuat" panel sitting on top of the NEW draft's
   * fields with them locked. The UI lock below closes the straightforward
   * "click save, then type and send" ordering; this counter is what closes
   * every ordering, including ones that do not go through the composer at all
   * (e.g. clicking "Buat komunitas ini" on an OLDER, still-displayed draft
   * while an earlier `sendAiMessage` call is still resolving).
   */
  const draftGenerationRef = useRef(0);
  /** Always the latest rendered value — read from async closures instead of a stale one captured at `handleSend`'s own start. */
  const draftFormRef = useRef<DraftFormState | null>(draftForm);
  draftFormRef.current = draftForm;
  const saveStateRef = useRef<SaveState>(saveState);
  saveStateRef.current = saveState;
  const createdCommunityRef = useRef<Community | null>(createdCommunity);
  createdCommunityRef.current = createdCommunity;

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
        // BEFORE the panel is replaced: if the draft being replaced is the
        // one that created `createdCommunity` and it left any tier KNOWN to
        // be unfinished, remember those names now — this is the only moment
        // that fact is still attached to a live draft at all.
        //
        // "KNOWN" excludes `"creating"` ON PURPOSE. A tier whose `POST` is
        // still in flight at this exact instant has an outcome the draft-
        // generation guard is ABOUT to throw away (the bump two lines below
        // makes that request's eventual response — success or failure — get
        // dropped, never writing `"created"` even if that is what happened)
        // — so `status` here is not "not created", it is "we will never
        // find out". Reporting it as outstanding would be a FALSE claim that
        // can never self-correct: the creator follows the link to the Paket
        // page and finds the tier already sitting there. `"failed"` (a real,
        // observed failure) and `"pending"` (never even attempted — e.g. the
        // sequential loop had not reached it yet) are both genuinely known
        // to be unfinished; only those two are reported.
        const priorDraftForm = draftFormRef.current;
        const priorSaveState = saveStateRef.current;
        const created = createdCommunityRef.current;
        if (
          priorDraftForm !== null &&
          priorSaveState.kind === "saved" &&
          created !== null &&
          priorSaveState.community.id === created.id
        ) {
          const outstanding = priorDraftForm.tiers
            .filter((tier) => tier.status === "failed" || tier.status === "pending")
            .map((tier) => tier.name.trim())
            .filter((name) => name !== "");
          setOutstandingTiers({ communityId: created.id, names: outstanding });
        }
        // Bumped BEFORE the replacement, and unconditionally on every new
        // draft — any save already in flight for the draft being replaced
        // must lose the race from this point on, whether or not it belongs
        // to the community above.
        draftGenerationRef.current += 1;
        setDraftForm(toDraftForm(result.draft));
        setSaveState({ kind: "idle" });
        setConfirmSeparateCommunity(false);
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

  function updateTierField(
    index: number,
    patch: Partial<Pick<DraftTierForm, "name" | "price" | "billingCycle">>
  ) {
    setDraftForm((prev) => {
      if (prev === null) return prev;
      // A general (whole-tier) failure was about the OLD values; any edit
      // makes it stale. The per-field errors clear only for the field that
      // actually changed, same as `TiersPage`.
      const clear: Partial<DraftTierForm> = { generalError: undefined };
      if ("name" in patch) clear.nameError = undefined;
      if ("price" in patch) clear.priceError = undefined;
      return updateTierAt(prev, index, { ...patch, ...clear });
    });
  }

  /**
   * Runs `POST /communities/:id/tiers` for each of `indices`, in order,
   * recording each one's own outcome — but ONLY while `startedGeneration`
   * still matches the live draft generation. Checked before starting each
   * tier (so a stale call never even issues its next request) and again
   * after every `await` (so a request already in flight when the draft
   * changed underneath it cannot write its result into whatever now
   * occupies that same tier index).
   */
  async function runTierAttempts(
    communityId: string,
    indices: number[],
    parsedByIndex: ReadonlyMap<number, { name: string; priceAmount: number; billingCycle: string }>,
    startedGeneration: number
  ) {
    for (const index of indices) {
      if (draftGenerationRef.current !== startedGeneration) return;
      const parsed = parsedByIndex.get(index);
      if (parsed === undefined) continue;
      setDraftForm((prev) => (prev === null ? prev : updateTierAt(prev, index, { status: "creating" })));
      try {
        await apiFetch<Tier>(`/communities/${communityId}/tiers`, {
          method: "POST",
          body: JSON.stringify(parsed),
        });
        if (draftGenerationRef.current !== startedGeneration) return;
        setDraftForm((prev) =>
          prev === null
            ? prev
            : updateTierAt(prev, index, {
                status: "created",
                nameError: undefined,
                priceError: undefined,
                generalError: undefined,
              })
        );
      } catch (err) {
        if (draftGenerationRef.current !== startedGeneration) return;
        setDraftForm((prev) =>
          prev === null ? prev : updateTierAt(prev, index, { status: "failed", ...tierErrorPatch(err) })
        );
      }
    }
  }

  /**
   * `POST /communities` then `POST .../tiers` for every tier — THE ONLY WRITE
   * PATH this screen has (ruling #2). Every tier is validated locally first,
   * same rule and same message as `TiersPage`'s `parseRupiahInput`, so an
   * obviously-bad price never even reaches the network.
   *
   * CALLABLE FROM "idle" OR "community_error" — never from "creating_community"
   * (already in flight) or "saved" (would re-create the same community). This
   * is what makes the `community_error` panel's own "Coba lagi" button
   * actually retry, rather than silently no-op: a prior bug guarded this with
   * `saveState.kind !== "idle"`, which is true for `community_error` too, so
   * the very button offered on a failed save could never do anything.
   */
  async function saveCommunity() {
    if (draftForm === null) return;
    if (saveState.kind === "creating_community" || saveState.kind === "saved") return;

    const trimmedName = draftForm.name.trim();
    const trimmedNiche = draftForm.niche.trim();

    let hasFieldError = false;
    const parsedByIndex = new Map<number, { name: string; priceAmount: number; billingCycle: string }>();
    const validatedTiers = draftForm.tiers.map((tier, index) => {
      const name = tier.name.trim();
      if (name === "") {
        hasFieldError = true;
        return { ...tier, nameError: "Nama paket wajib diisi.", priceError: undefined, generalError: undefined };
      }
      const parsed = parseRupiahInput(tier.price);
      if ("error" in parsed) {
        hasFieldError = true;
        return { ...tier, nameError: undefined, priceError: parsed.error, generalError: undefined };
      }
      parsedByIndex.set(index, { name, priceAmount: parsed.amount, billingCycle: tier.billingCycle });
      return { ...tier, nameError: undefined, priceError: undefined, generalError: undefined };
    });

    // Committed REGARDLESS of the name check below — a bad tier price must
    // never be silently discarded just because the name was ALSO blank.
    if (hasFieldError) {
      setDraftForm({ ...draftForm, tiers: validatedTiers });
    }

    if (trimmedName === "") {
      setSaveState({ kind: "community_error", message: "Nama komunitas wajib diisi." });
      return;
    }
    if (hasFieldError) {
      // No request at all — mirrors CreateTierForm: money never becomes a
      // float (or a blank name) on the way to the API. `saveState` stays
      // whatever it already was (idle, or a previous community_error the
      // creator has not yet fixed) rather than being overwritten here.
      return;
    }

    setDraftForm({ ...draftForm, tiers: validatedTiers });
    setSaveState({ kind: "creating_community" });

    // Captured BEFORE the network call — this save belongs to whichever
    // draft is live right now, and every write below re-checks this exact
    // value before touching `saveState`/`draftForm`. `saveInFlight` disables
    // the composer for the same window, but is not what makes this safe —
    // see the ref's own docstring.
    const startedGeneration = draftGenerationRef.current;
    setSaveInFlight(true);
    try {
      let community: Community;
      try {
        community = await apiFetch<Community>("/communities", {
          method: "POST",
          body: JSON.stringify({ name: trimmedName, ...(trimmedNiche === "" ? {} : { niche: trimmedNiche }) }),
        });
      } catch (err) {
        if (draftGenerationRef.current === startedGeneration) {
          // BACK TO AN EDITABLE, RE-SUBMITTABLE STATE — never a dead end.
          // Every input this panel disables is keyed off
          // `saveState.kind !== "idle" && saveState.kind !== "community_error"`,
          // so this state re-enables them, and `saveCommunity`'s own guard
          // above allows this exact function to run again from here.
          setSaveState({
            kind: "community_error",
            message: err instanceof Error ? err.message : "Tidak dapat menghubungi server. Coba lagi.",
          });
        }
        // A stale generation means a new draft already replaced this one —
        // there is nothing left on screen for a `community_error` to attach
        // to, so the write is dropped rather than resurrecting the old panel.
        return;
      }

      if (draftGenerationRef.current !== startedGeneration) return;

      // The community exists now, no matter what happens to any tier below —
      // this state can never go back to "idle", so a tier failure can never
      // make this screen try to create the SAME community a second time.
      setSaveState({ kind: "saved", community });
      // STICKY — see the field's own docstring. Set once, kept forever, so a
      // LATER draft in this same conversation can never silently create a
      // second community with one more click.
      setCreatedCommunity(community);
      await runTierAttempts(
        community.id,
        validatedTiers.map((_, index) => index),
        parsedByIndex,
        startedGeneration
      );
    } finally {
      setSaveInFlight(false);
    }
  }

  /**
   * Retries ONLY the tiers currently marked `"failed"`, using whatever the
   * creator has edited since — never the community (already created) and
   * never a tier already marked `"created"` (would duplicate it).
   */
  async function retryFailedTiers() {
    // `saveInFlight` closes the same hole `saveCommunity`'s own guard closed
    // in round 1 — a rapid double-click firing this twice before the first
    // call's `setSaveInFlight(true)` has even committed would otherwise
    // compute the SAME `failedIndices` twice and double-POST the same tier.
    // Checked here, not just via the button's own `disabled` prop, for the
    // same reason the draft-generation guard is not just a UI lock: a
    // disabled attribute is a convention a test (or a stray event) can
    // bypass; this is the actual correctness check.
    if (saveState.kind !== "saved" || draftForm === null || saveInFlight) return;

    const failedIndices: number[] = [];
    let hasFieldError = false;
    const parsedByIndex = new Map<number, { name: string; priceAmount: number; billingCycle: string }>();

    const nextTiers = draftForm.tiers.map((tier, index) => {
      if (tier.status !== "failed") return tier;
      failedIndices.push(index);
      const name = tier.name.trim();
      if (name === "") {
        hasFieldError = true;
        return { ...tier, nameError: "Nama paket wajib diisi.", priceError: undefined, generalError: undefined };
      }
      const parsed = parseRupiahInput(tier.price);
      if ("error" in parsed) {
        hasFieldError = true;
        return { ...tier, nameError: undefined, priceError: parsed.error, generalError: undefined };
      }
      parsedByIndex.set(index, { name, priceAmount: parsed.amount, billingCycle: tier.billingCycle });
      return { ...tier, nameError: undefined, priceError: undefined, generalError: undefined };
    });

    if (failedIndices.length === 0) return;
    setDraftForm({ ...draftForm, tiers: nextTiers });
    if (hasFieldError) return;

    const startedGeneration = draftGenerationRef.current;
    setSaveInFlight(true);
    try {
      await runTierAttempts(saveState.community.id, failedIndices, parsedByIndex, startedGeneration);
    } finally {
      setSaveInFlight(false);
    }
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
          {/* Same guardrail `CommunitiesPage`/`TiersPage` show around the exact
              same two endpoints this screen calls — a creator who builds an
              entire community here must see it too, not just on the two
              manual screens. */}
          <PaymentAccountNotice />

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
                // `disabled` mirrors the textarea/submit button below
                // (`saveInFlight`, see their own props) — this button calls
                // `handleSend()` directly, bypassing whatever the composer
                // itself renders as disabled, so without this a stale
                // send-error banner left over from before a save started
                // could start a second send mid-save: harmless (the draft
                // generation counter is the actual defence), but it broke
                // the convention every other control here enforces.
                <button
                  type="button"
                  className="button-secondary"
                  disabled={saveInFlight}
                  onClick={() => handleSend()}
                >
                  Coba lagi
                </button>
              ) : null}
            </div>
          ) : null}

          {/* A UI CONVENTION, not the actual fix (see `draftGenerationRef`'s
              docstring) — but required regardless: without it, a creator
              could send a follow-up while a save's tier requests are still
              running, which is the exact ordering that used to corrupt the
              screen even though the generation counter alone already stops
              the corruption itself. */}
          {saveInFlight ? (
            <p className="muted" data-testid="save-in-flight-notice">
              Menyimpan komunitas — tunggu sampai selesai sebelum mengirim pesan baru.
            </p>
          ) : null}

          <form onSubmit={handleSend} className="chat-composer">
            <textarea
              aria-label="Pesan Anda"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              disabled={sending || saveInFlight}
              maxLength={4000}
              placeholder="Tulis pesan Anda di sini..."
            />
            <button
              type="submit"
              className="button-primary"
              disabled={sending || saveInFlight || content.trim() === ""}
            >
              Kirim
            </button>
          </form>

          {draftForm !== null ? (
            <DraftPanel
              draftForm={draftForm}
              saveState={saveState}
              createdCommunity={createdCommunity}
              outstandingTiers={outstandingTiers}
              confirmSeparateCommunity={confirmSeparateCommunity}
              onToggleConfirmSeparate={setConfirmSeparateCommunity}
              onChangeField={updateDraftField}
              onChangeTier={updateTierField}
              onSave={saveCommunity}
              onRetryFailedTiers={retryFailedTiers}
              saveInFlight={saveInFlight}
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
  createdCommunity,
  outstandingTiers,
  confirmSeparateCommunity,
  onToggleConfirmSeparate,
  onChangeField,
  onChangeTier,
  onSave,
  onRetryFailedTiers,
  saveInFlight,
}: {
  draftForm: DraftFormState;
  saveState: SaveState;
  createdCommunity: Community | null;
  outstandingTiers: { communityId: string; names: string[] } | null;
  confirmSeparateCommunity: boolean;
  onToggleConfirmSeparate: (checked: boolean) => void;
  onChangeField: (field: "name" | "niche" | "description" | "welcomeMessage", value: string) => void;
  saveInFlight: boolean;
  onChangeTier: (index: number, patch: Partial<Pick<DraftTierForm, "name" | "price" | "billingCycle">>) => void;
  onSave: () => void;
  onRetryFailedTiers: () => void;
}) {
  // Community-level fields lock only once THIS draft's own save is in flight
  // or has succeeded — a failed save (`community_error`) leaves them open,
  // because that is exactly the state a creator needs to fix and resubmit.
  const locked = saveState.kind === "creating_community" || saveState.kind === "saved";
  const anyTierFailed = draftForm.tiers.some((tier) => tier.status === "failed");
  // This draft has not been attempted yet, AND an EARLIER draft in this same
  // conversation already created a community — the duplicate-risk case.
  const risksDuplicate = saveState.kind === "idle" && createdCommunity !== null;

  return (
    <div className="card cobuilder-draft" data-testid="draft-panel">
      {/* STICKY, and independent of `saveState` — visible for every draft
          shown AFTER a community was created in this conversation, not just
          while `saveState.kind === "idle"` the way the duplicate-risk notice
          below is. This is the ONE place "already created X" and "X is
          missing these paket" live once the draft that made them is gone. */}
      {createdCommunity !== null ? (
        <div className="notice notice-info" data-testid="created-community-summary">
          <p>
            Komunitas “{createdCommunity.name}” berhasil dibuat.{" "}
            <Link to={`/dashboard/c/${createdCommunity.id}`}>Lihat komunitas</Link>.
          </p>
          {outstandingTiers !== null &&
          outstandingTiers.communityId === createdCommunity.id &&
          outstandingTiers.names.length > 0 ? (
            <p className="cell-warning" data-testid="outstanding-tiers-notice">
              Paket berikut belum dibuat untuk komunitas itu: {outstandingTiers.names.join(", ")}.
              Tambahkan secara manual di{" "}
              <Link to={`/dashboard/c/${createdCommunity.id}/tiers`}>halaman Paket</Link>.
            </p>
          ) : null}
        </div>
      ) : null}

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
            maxLength={255}
            onChange={(event) => onChangeField("name", event.target.value)}
          />
        </Field>
        <Field label="Bidang" name="draft-niche" hint="Disimpan ke kolom bidang komunitas.">
          <input
            id="field-draft-niche"
            value={draftForm.niche}
            disabled={locked}
            maxLength={128}
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
        risksDuplicate ? (
          <div className="notice notice-warning" data-testid="duplicate-risk-notice">
            <h3>Draf ini adalah revisi</h3>
            <p>
              Draf ini akan membuat komunitas BARU jika disimpan — bukan mengubah komunitas yang sudah
              dibuat di atas. Untuk mengubah paket atau info komunitas itu, gunakan{" "}
              <Link to={`/dashboard/c/${createdCommunity!.id}/tiers`}>halaman Paket</Link>.
            </p>
            <label className="row">
              <input
                type="checkbox"
                checked={confirmSeparateCommunity}
                onChange={(event) => onToggleConfirmSeparate(event.target.checked)}
              />
              Saya paham — simpan draf ini sebagai komunitas KEDUA yang terpisah dari “
              {createdCommunity!.name}”.
            </label>
            <button
              type="button"
              className="button-primary"
              disabled={!confirmSeparateCommunity}
              onClick={onSave}
            >
              Buat komunitas kedua ini
            </button>
          </div>
        ) : (
          <button type="button" className="button-primary" onClick={onSave}>
            Buat komunitas ini
          </button>
        )
      ) : null}

      {saveState.kind === "creating_community" ? <p className="muted">Menyimpan komunitas...</p> : null}

      {saveState.kind === "community_error" ? (
        <div className="form-error" role="alert">
          <p>{saveState.message}</p>
          <button type="button" className="button-primary" onClick={onSave}>
            Coba lagi
          </button>
        </div>
      ) : null}

      {saveState.kind === "saved" ? (
        <div className="form-ok" data-testid="save-result">
          {/* The "berhasil dibuat" confirmation and its link live in the
              STICKY summary banner at the top of this panel now, not here —
              that banner is what stays visible once a later draft replaces
              this one, which is the whole point of it being sticky. */}
          {anyTierFailed ? (
            <>
              <p className="cell-warning">
                Sebagian paket gagal disimpan. Perbaiki di bawah lalu coba lagi, atau tambahkan
                secara manual di{" "}
                <Link to={`/dashboard/c/${saveState.community.id}/tiers`}>halaman Paket</Link>.
              </p>
              <button
                type="button"
                className="button-secondary"
                onClick={onRetryFailedTiers}
                disabled={saveInFlight}
              >
                Coba lagi paket yang gagal
              </button>
            </>
          ) : (
            <p className="muted">Tersimpan.</p>
          )}
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
  onChange: (index: number, patch: Partial<Pick<DraftTierForm, "name" | "price" | "billingCycle">>) => void;
}) {
  const parsedPrice = parseRupiahInput(tier.price);
  const priceHint =
    "error" in parsedPrice
      ? billingCycleLabel(tier.billingCycle)
      : `${formatRupiah(parsedPrice.amount)} ${billingCycleLabel(tier.billingCycle)}`;

  return (
    <div className="card" data-testid={`tier-row-${index}`}>
      <div className="inline-form">
        <Field label={`Nama paket ${index + 1}`} name={`tier-name-${index}`} error={tier.nameError}>
          <input
            id={`field-tier-name-${index}`}
            value={tier.name}
            disabled={locked}
            maxLength={128}
            onChange={(event) => onChange(index, { name: event.target.value })}
          />
        </Field>
        <Field
          label={`Harga paket ${index + 1} (Rupiah)`}
          name={`tier-price-${index}`}
          error={tier.priceError}
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
        <Field label={`Siklus paket ${index + 1}`} name={`tier-cycle-${index}`}>
          <select
            id={`field-tier-cycle-${index}`}
            value={tier.billingCycle}
            disabled={locked}
            onChange={(event) => onChange(index, { billingCycle: event.target.value })}
          >
            {BILLING_CYCLES.map((cycle) => (
              <option key={cycle} value={cycle}>
                {billingCycleOptionLabel(cycle)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {tier.generalError !== undefined ? (
        <p className="field-error" data-testid={`tier-general-error-${index}`}>
          {tier.generalError}
        </p>
      ) : null}
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
