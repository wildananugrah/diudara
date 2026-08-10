import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import { publicCheckoutUrl } from "../format";
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
      <StatusExplanation status={community.status} />
      <CopyableLink
        url={publicCheckoutUrl(community.slug)}
        label="Tautan checkout publik — sebarkan ini ke calon anggota"
      />
    </article>
  );
}

function CreateCommunityForm({ onCreated }: { onCreated: (created: Community) => void }) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

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
        body: JSON.stringify({ name, ...(niche.trim() === "" ? {} : { niche: niche.trim() }) }),
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
        </div>
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
