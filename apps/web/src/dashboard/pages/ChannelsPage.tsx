import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import { platformLabel } from "../format";
import { CommunityHeader, EmptyState, ErrorPanel, Field, NotFoundPanel } from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import type { Channel } from "../types";

/**
 * A Telegram `chat_id` as an integer.
 *
 * DUPLICATED FROM `connectChannelSchema` (packages/shared/src/community.schema.ts)
 * ON PURPOSE, and this is the one place in the dashboard where a rule is restated
 * rather than imported. Importing the schema itself would be the obvious fix and
 * would pull ZOD INTO THE BROWSER BUNDLE — `@diudara/shared`'s index re-exports the
 * schema modules, and a `z.object()` call at module scope is not something a bundler
 * will tree-shake away. The plan's constraint is "no new runtime dependencies", and
 * every existing `@diudara/shared` import in apps/web is type-only for exactly that
 * reason (see api.ts).
 *
 * So: the API remains the authority — a value that gets past this still has to pass
 * `connectChannelSchema`, and the 400 that comes back is rendered on this field.
 * This regex only exists so the creator is told BEFORE they submit, in Indonesian.
 * If the server's rule ever changes, the server still wins; this would merely
 * become over-strict, which fails in the safe direction.
 */
const TELEGRAM_NUMERIC_CHAT_ID = /^-?[0-9]{1,20}$/;

/**
 * The message a creator reads instead of the API's English one.
 *
 * It has to say all four things, because `@username` is the form they will reach
 * for — it is what the Telegram client shows them, and it WORKS for the outbound
 * half. What it breaks is inbound: a `chat_member` update carries `chat.id` as a
 * NUMBER, so a join against `@kelasbudi` never matches, no `external_member_id` is
 * ever recorded, and every later revocation reports
 * `no_provider_member_id_recorded` forever. Access can be granted and never taken
 * away — silently. See the long comment on `connectChannelSchema`.
 */
const TELEGRAM_HINT =
  "Telegram memerlukan ID chat berupa ANGKA (misalnya -1001234567890) — bukan @username, " +
  "bukan tautan undangan. Cara mendapatkannya: tambahkan bot DIUDARA ke grup sebagai admin, " +
  "lalu baca ID numeriknya dari getChat atau dari bot info grup. Jika Anda memasukkan " +
  "@username, undangan tetap bisa dikirim, tetapi anggota tidak akan pernah bisa dikeluarkan " +
  "otomatis ketika keanggotaannya berhenti.";

const TELEGRAM_INVALID =
  "ID chat Telegram harus berupa angka (misalnya -1001234567890), bukan @username atau tautan.";

const PLATFORMS = ["telegram", "whatsapp"] as const;

export default function ChannelsPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [communityLoad] = useCommunity(communityId);
  const [channelsLoad, channelsHandle] = useLoad(
    () => apiFetch<Channel[]>(`/communities/${communityId}/channels`),
    [communityId]
  );

  if (communityLoad.kind === "loading") return <p className="muted">Memuat...</p>;
  if (communityLoad.kind === "error") return <ErrorPanel message={communityLoad.message} />;
  if (communityLoad.data === null) return <NotFoundPanel />;

  return (
    <section>
      <CommunityHeader community={communityLoad.data} />
      <h2>Grup terhubung</h2>
      <p className="muted">
        Anggota yang membayar dimasukkan ke grup ini secara otomatis, dan dikeluarkan otomatis
        ketika keanggotaannya berakhir.
      </p>

      {channelsLoad.kind === "loading" ? <p className="muted">Memuat grup...</p> : null}
      {channelsLoad.kind === "error" ? (
        <ErrorPanel message={channelsLoad.message} onRetry={channelsHandle.reload} />
      ) : null}

      {channelsLoad.kind === "ready" ? (
        <>
          <div className="section">
            {channelsLoad.data.length === 0 ? (
              <EmptyState
                title="Belum ada grup terhubung"
                action="Hubungkan grup Telegram atau WhatsApp Anda di bawah, supaya anggota yang membayar bisa masuk sendiri."
              />
            ) : (
              <div className="card-list">
                {channelsLoad.data.map((channel) => (
                  <ChannelCard key={channel.id} channel={channel} />
                ))}
              </div>
            )}
          </div>
          <ConnectChannelForm
            communityId={communityId!}
            onConnected={(channel) => channelsHandle.update([...channelsLoad.data, channel])}
          />
        </>
      ) : null}
    </section>
  );
}

function ChannelCard({ channel }: { channel: Channel }) {
  return (
    <article className="card">
      <div className="spread">
        <div>
          <h3>{platformLabel(channel.platform)}</h3>
          <p className="muted">
            ID grup: <code>{channel.externalGroupId ?? "—"}</code>
          </p>
        </div>
        <span className={`badge ${channel.botStatus === "connected" ? "badge-active" : ""}`}>
          {channel.botStatus === "connected" ? "Bot terhubung" : "Bot belum terhubung"}
        </span>
      </div>
      {channel.platform === "whatsapp" ? (
        <p className="hint">
          WhatsApp tidak dapat mengeluarkan anggota secara otomatis. Ketika keanggotaan berakhir,
          Anda akan diberi tahu di halaman Aktivitas dan harus mengeluarkannya sendiri dari grup.
        </p>
      ) : (
        <p className="hint">
          Pastikan bot DIUDARA masih menjadi admin di grup ini — tanpa itu, undangan tidak bisa
          dibuat dan anggota tidak bisa dikeluarkan.
        </p>
      )}
    </article>
  );
}

function ConnectChannelForm({
  communityId,
  onConnected,
}: {
  communityId: string;
  onConnected: (channel: Channel) => void;
}) {
  const [platform, setPlatform] = useState<string>("telegram");
  const [externalGroupId, setExternalGroupId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});

    const groupId = externalGroupId.trim();
    if (platform === "telegram" && !TELEGRAM_NUMERIC_CHAT_ID.test(groupId)) {
      // Told before the request, in Indonesian, on the field. WhatsApp is
      // deliberately untouched: its ids are `120363…@g.us` and nothing inbound
      // depends on their shape.
      setFieldErrors({ externalGroupId: TELEGRAM_INVALID });
      return;
    }

    setSubmitting(true);
    try {
      const created = await apiFetch<Channel>(`/communities/${communityId}/channels`, {
        method: "POST",
        body: JSON.stringify({ platform, externalGroupId: groupId }),
      });
      setExternalGroupId("");
      onConnected(created);
    } catch (err) {
      if (err instanceof DashboardApiError) {
        if (err.status === 409) {
          // Never says WHICH community holds it — the API withholds that on purpose
          // so a stranger cannot confirm another creator's setup, and repeating a
          // guess here would undo it. Form state is untouched.
          setMessage(
            "Grup ini sudah terhubung ke sebuah komunitas. Satu grup hanya bisa dipakai oleh satu komunitas."
          );
        } else {
          setFieldErrors(err.fieldErrors);
          setMessage(Object.keys(err.fieldErrors).length > 0 ? null : err.message);
        }
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Hubungkan grup</h3>
      <form onSubmit={submit} className="stack" noValidate>
        <div className="inline-form">
          <Field label="Platform" name="platform" error={fieldErrors.platform}>
            <select
              id="field-platform"
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value);
                setFieldErrors({});
              }}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {platformLabel(p)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={platform === "telegram" ? "ID grup (angka)" : "ID grup"}
            name="externalGroupId"
            error={fieldErrors.externalGroupId}
          >
            <input
              id="field-externalGroupId"
              type="text"
              value={externalGroupId}
              onChange={(e) => setExternalGroupId(e.target.value)}
              placeholder={platform === "telegram" ? "-1001234567890" : "120363123456789@g.us"}
              aria-invalid={fieldErrors.externalGroupId !== undefined}
            />
          </Field>
        </div>

        {platform === "telegram" ? (
          <p className="notice notice-warning" data-testid="telegram-chat-id-hint">
            {TELEGRAM_HINT}
          </p>
        ) : (
          <p className="hint">
            ID grup WhatsApp berbentuk <code>120363…@g.us</code>. Perlu diingat: WhatsApp tidak
            dapat mengeluarkan anggota secara otomatis.
          </p>
        )}

        {message !== null ? (
          <p className="form-error" role="alert">
            {message}
          </p>
        ) : null}

        <div>
          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Menghubungkan..." : "Hubungkan grup"}
          </button>
        </div>
      </form>
    </div>
  );
}
