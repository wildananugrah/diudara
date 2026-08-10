import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import { communityStatusLabel } from "../format";
import {
  CheckoutLink,
  CommunityHeader,
  ErrorPanel,
  Field,
  NotFoundPanel,
  StatusExplanation,
} from "../ui";
import { useCommunity } from "../useCommunity";
import type { Community } from "../types";

/** `updateCommunitySchema`'s enum. Offering anything else would earn a 400. */
const STATUSES = ["active", "paused", "archived"] as const;

/**
 * One community's overview: what state it is in, the link to share, and the two
 * settings a creator actually changes.
 *
 * Task 7 adds the metrics to this screen.
 */
export default function CommunityOverviewPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [load, handle] = useCommunity(communityId);

  if (load.kind === "loading") return <p className="muted">Memuat...</p>;
  if (load.kind === "error") return <ErrorPanel message={load.message} onRetry={handle.reload} />;
  if (load.data === null) return <NotFoundPanel />;

  const community = load.data;

  return (
    <section>
      <CommunityHeader community={community} />

      <div className="section card stack">
        <div>
          <h2>Status: {communityStatusLabel(community.status)}</h2>
          <StatusExplanation status={community.status} />
        </div>
        <CheckoutLink community={community} />
      </div>

      <div className="section card">
        <h2>Pengaturan</h2>
        <StatusForm community={community} onSaved={handle.update} />
        <SlugForm community={community} onSaved={handle.update} />
      </div>
    </section>
  );
}

/** `PATCH /communities/:id` with the one field being changed, never the whole record. */
async function patchCommunity(
  communityId: string,
  patch: Record<string, unknown>
): Promise<Community> {
  return apiFetch<Community>(`/communities/${communityId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

function StatusForm({
  community,
  onSaved,
}: {
  community: Community;
  onSaved: (next: Community) => void;
}) {
  const [status, setStatus] = useState(community.status);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      onSaved(await patchCommunity(community.id, { status }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "gagal menyimpan status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="inline-form">
        <Field label="Status" name="status">
          <select id="field-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {communityStatusLabel(value)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {message !== null ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="button-secondary" disabled={saving}>
          {saving ? "Menyimpan..." : "Simpan status"}
        </button>
      </div>
    </form>
  );
}

function SlugForm({
  community,
  onSaved,
}: {
  community: Community;
  onSaved: (next: Community) => void;
}) {
  const [slug, setSlug] = useState(community.slug);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSaving(true);
    try {
      onSaved(await patchCommunity(community.id, { slug }));
    } catch (err) {
      // The slug the creator typed is NOT reverted: they have to change it anyway,
      // and resetting the field would make them retype the whole thing.
      if (err instanceof DashboardApiError) {
        if (err.status === 409) {
          setMessage(
            "Alamat tautan itu sudah dipakai. Coba yang lain — alamat tautan harus unik di seluruh DIUDARA."
          );
        } else {
          setFieldErrors(err.fieldErrors);
          setMessage(Object.keys(err.fieldErrors).length > 0 ? null : err.message);
        }
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="inline-form">
        <Field
          label="Alamat tautan (slug)"
          name="slug"
          error={fieldErrors.slug}
          hint="Huruf kecil, angka dan tanda hubung tunggal. Mengubahnya MEMATIKAN tautan lama yang sudah Anda sebarkan."
        >
          <input
            id="field-slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-invalid={fieldErrors.slug !== undefined}
          />
        </Field>
      </div>
      {message !== null ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="button-secondary" disabled={saving}>
          {saving ? "Menyimpan..." : "Simpan tautan"}
        </button>
      </div>
    </form>
  );
}
