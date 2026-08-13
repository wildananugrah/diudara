import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import { subscribeToAuth } from "../auth";
import {
  ACCESS_MODES,
  accessModeLabel,
  publicCheckoutUrl,
  publicLinkLabel,
  REQUEST_ONLY,
} from "../format";
import {
  ensurePaymentAccountStatusLoaded,
  getPaymentsAvailable,
} from "../paymentAccount";
import {
  CopyableLink,
  EmptyState,
  ErrorPanel,
  Field,
  PaymentAccountNotice,
  StatusBadge,
  StatusExplanation,
} from "../ui";
import { useLoad } from "../useLoad";
import type { Community } from "../types";

/**
 * The creator's communities — the dashboard's home, and the first screen anybody
 * ever sees.
 *
 * It carries the checkout link for every community rather than hiding it one click
 * deeper, because that link is the thing a creator broadcasts and the entire
 * product depends on them sharing it.
 */
export default function CommunitiesPage() {
  const [load, handle] = useLoad(() => apiFetch<Community[]>("/communities"), []);

  return (
    <section>
      <h1>Komunitas Anda</h1>
      <PaymentAccountNotice />

      {load.kind === "loading" ? <p className="muted">Memuat...</p> : null}
      {load.kind === "error" ? <ErrorPanel message={load.message} onRetry={handle.reload} /> : null}

      {load.kind === "ready" ? (
        <>
          <div className="section">
            {load.data.length === 0 ? (
              <EmptyState
                title="Belum ada komunitas"
                action="Buat komunitas pertama Anda dengan formulir di bawah. Setelah itu: tentukan paket, hubungkan grup, lalu sebarkan tautan checkout."
              />
            ) : (
              <div className="card-list">
                {load.data.map((community) => (
                  <CommunityCard key={community.id} community={community} />
                ))}
              </div>
            )}
          </div>

          {/* Newest first, and inserted in place rather than re-fetching: the POST
              already returned the row, so a second GET could only disagree. */}
          <CreateCommunityForm onCreated={(created) => handle.update([created, ...load.data])} />
        </>
      ) : null}
    </section>
  );
}

function CommunityCard({ community }: { community: Community }) {
  return (
    <article className="card">
      <div className="spread">
        <div>
          <h2>
            <Link to={`/dashboard/c/${community.id}`}>{community.name}</Link>
          </h2>
          {community.niche !== null ? <p className="muted">{community.niche}</p> : null}
        </div>
        <StatusBadge status={community.status} />
      </div>
      <StatusExplanation status={community.status} accessMode={community.accessMode} />
      <CopyableLink url={publicCheckoutUrl(community.slug)} label={publicLinkLabel(community)} />
    </article>
  );
}

function CreateCommunityForm({ onCreated }: { onCreated: (created: Community) => void }) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /**
   * Whether this SERVER has a payment provider at all — not whether this
   * creator has connected one. See `paymentAccount.ts`'s `paymentsAvailable`
   * for why the two are different questions and why the unknown case fails
   * toward offering both modes.
   *
   * Loaded here rather than relying on `PaymentAccountNotice` being mounted
   * alongside: the guards inside `ensurePaymentAccountStatusLoaded` make N
   * callers cost at most one request, so asking for it directly is free and
   * removes a dependency on another component's lifecycle.
   */
  const paymentsAvailable = useSyncExternalStore(subscribeToAuth, getPaymentsAvailable);
  useEffect(() => {
    ensurePaymentAccountStatusLoaded();
  }, []);
  const paidPossible = paymentsAvailable !== "unavailable";
  /**
   * `"paid"` normally — the same value `CreateCommunity` assumes for a missing
   * `accessMode`, so the default behaviour of this form does not change. On a
   * box with no payment provider, `"request"` is the ONLY thing that can be
   * created (`CreateCommunity` 409s everything else), so that is both the
   * default and the only option offered.
   */
  const [accessMode, setAccessMode] = useState<string>("paid");
  const effectiveAccessMode = paidPossible ? accessMode : "request";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const created = await apiFetch<Community>("/communities", {
        method: "POST",
        // An OMITTED niche, not an empty string: `createCommunitySchema` treats the
        // field as optional, and `""` would be stored as an empty niche that then
        // renders as a blank line under every community's name.
        //
        // `accessMode` is sent EXPLICITLY, including when it is `"paid"`. It was
        // omitted before, which `CreateCommunity` reads as `"paid"` — identical on
        // a payments-enabled box, and a guaranteed 409 on one without payments,
        // where "not explicitly request" is exactly what it refuses.
        body: JSON.stringify({
          name,
          ...(niche.trim() === "" ? {} : { niche: niche.trim() }),
          accessMode: effectiveAccessMode,
        }),
      });
      setName("");
      setNiche("");
      onCreated(created);
    } catch (err) {
      // Nothing is cleared on failure: the form keeps what was typed.
      if (err instanceof DashboardApiError) {
        setFieldErrors(err.fieldErrors);
        setMessage(Object.keys(err.fieldErrors).length > 0 ? null : err.message);
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h2>Buat komunitas baru</h2>
      <p className="muted">
        Alamat tautan (slug) dibuat otomatis dari namanya, dan bisa Anda ubah nanti di halaman
        komunitas.
      </p>
      <form onSubmit={submit} className="stack" noValidate>
        <div className="inline-form">
          <Field label="Nama komunitas" name="name" error={fieldErrors.name}>
            <input
              id="field-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fieldErrors.name !== undefined}
            />
          </Field>
          <Field label="Bidang (opsional)" name="niche" error={fieldErrors.niche}>
            <input
              id="field-niche"
              type="text"
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="bimbel, ternak lele, trading"
            />
          </Field>
          <Field
            label="Cara bergabung"
            name="access-mode"
            hint="Bisa diubah kapan saja di halaman komunitas."
          >
            <select
              id="field-access-mode"
              value={effectiveAccessMode}
              onChange={(e) => setAccessMode(e.target.value)}
              disabled={!paidPossible}
            >
              {(paidPossible ? ACCESS_MODES : REQUEST_ONLY).map((value) => (
                <option key={value} value={value}>
                  {accessModeLabel(value)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {paidPossible ? null : (
          <p className="muted" data-testid="payments-unavailable-hint">
            Server ini belum dikonfigurasi untuk menerima pembayaran, jadi komunitas berbayar
            belum bisa dibuat di sini. Komunitas gratis — anggota mengajukan permintaan dan Anda
            menyetujui — tetap bisa.
          </p>
        )}
        {message !== null ? (
          <p className="form-error" role="alert">
            {message}
          </p>
        ) : null}
        <div>
          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Buat komunitas"}
          </button>
        </div>
      </form>
    </div>
  );
}
