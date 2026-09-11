import { useEffect, useState } from "react";
import {
  ALLOWED_DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  isAllowedDocumentType,
} from "@diudara/shared";
import {
  deleteCommunityDocument,
  downloadCommunityDocument,
  listCommunityDocuments,
  uploadCommunityDocument,
  type CommunityDocumentRow,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { formatBytes } from "./formatBytes";
import { formatRelativeTime } from "./relativeTime";

interface Props {
  slug: string;
  viewerIsOwner: boolean;
  /** `true` member, `false` signed-in non-member, `null` signed out — `CommunityDetail`'s own shape. */
  viewerIsMember: boolean | null;
  /** Injected clock for `formatRelativeTime`, the rule every dated component here follows. */
  now?: Date;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

/**
 * The **Dokumen** tab of `/komunitas/:slug` — the community's file library.
 *
 * **The list is open and the bytes are not.** Anyone sees names, sizes and
 * dates, which is what keeps a community evaluable before joining (Phase 1's
 * argument for open reading); only a member gets a download control, and the
 * SERVER decides that — `viewerMayDownload` comes off the response rather than
 * being inferred here from `viewerIsMember`. Two sources for one answer is how
 * a control gets rendered for an action that fails.
 *
 * The owner additionally gets an upload input and a delete on each row.
 */
/**
 * Why THIS viewer cannot open THIS document. Three different answers, because
 * three different actions fix them: sign in, join, or subscribe. One generic
 * "tidak tersedia" would leave a member who only needs to subscribe with
 * nothing to do.
 *
 * Driven by `membersOnly` and the viewer's relationship — never by guessing
 * from `mayDownload` alone, which says only that the answer was no.
 */
function lockReason(
  document: CommunityDocumentRow,
  viewerIsMember: boolean | null
): string {
  if (viewerIsMember === null) return "Masuk untuk unduh";
  if (!viewerIsMember) return "Gabung untuk unduh";
  // A member who still cannot open it: the document is paid and their
  // subscription is missing or lapsed.
  return document.membersOnly ? "Khusus anggota berbayar" : "Tidak tersedia";
}

export default function DokumenTab({ slug, viewerIsOwner, viewerIsMember, now }: Props) {
  const [documents, setDocuments] = useState<CommunityDocumentRow[]>([]);
  // Phase 5. The owner's choice for the NEXT upload, not a property of the
  // list — it seeds the checkbox and rides out on the next file chosen.
  const [nextMembersOnly, setNextMembersOnly] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // Separate from `load`: a failed upload or delete must not replace the list
  // with an error page — the library is still there and still readable.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clock = now ?? new Date();

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    listCommunityDocuments(slug)
      .then((page) => {
        if (cancelled) return;
        setDocuments(page.documents);
        setLoad({ status: "ready" });
      })
      .catch((error: unknown) => {
        // An error, NOT an empty library: "Belum ada dokumen" over a failed
        // request tells the reader this community has nothing, which is a lie
        // they cannot detect.
        if (!cancelled) setLoad({ status: "error", message: describeRequestFailure(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Clear the input immediately so choosing the SAME file twice after a
    // failure still fires a change event.
    event.target.value = "";
    if (file === undefined) return;

    // Checked here as well as on the server, and the limits come from
    // `@diudara/shared` so the two cannot drift — `document.schema.ts`'s own
    // docstring explains which direction of drift is dangerous. This is a
    // courtesy that names the limit before the upload is spent, not the rule
    // itself.
    if (file.size > MAX_DOCUMENT_BYTES) {
      setActionError(`Berkas terlalu besar. Batasnya ${formatBytes(MAX_DOCUMENT_BYTES)}.`);
      return;
    }
    if (!isAllowedDocumentType(file.type)) {
      setActionError("Format berkas tidak didukung.");
      return;
    }

    setBusy(true);
    setActionError(null);
    try {
      const created = await uploadCommunityDocument(slug, file, nextMembersOnly);
      // Prepended, not refetched — the list is newest-first and this is the
      // newest. The pattern `PostFeed.prepend` uses.
      setDocuments((current) => [created, ...current]);
    } catch (error: unknown) {
      setActionError(`Dokumen gagal diunggah. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(document: CommunityDocumentRow): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      await downloadCommunityDocument(slug, document.id, document.name);
    } catch (error: unknown) {
      setActionError(`Dokumen gagal diunduh. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(document: CommunityDocumentRow): Promise<void> {
    // CONFIRM, then send, then remove — the order `PostCard`'s
    // `onDeleteRequested` docstring records. Removing the row first shows the
    // owner a deletion the server was never asked about, and leaves it
    // deleted on screen when the request fails.
    if (!window.confirm(`Hapus ${document.name}? Berkas ini tidak bisa dikembalikan.`)) return;

    setBusy(true);
    setActionError(null);
    try {
      await deleteCommunityDocument(slug, document.id);
      setDocuments((current) => current.filter((row) => row.id !== document.id));
    } catch (error: unknown) {
      setActionError(`Dokumen gagal dihapus. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  if (load.status === "loading") return <p>Memuat...</p>;
  if (load.status === "error") {
    return (
      <p className="form-error" role="alert">
        {load.message}
      </p>
    );
  }

  return (
    <section className="dokumen-tab">
      {viewerIsOwner ? (
        <div className="dokumen-upload">
          <label htmlFor="dokumen-upload">Unggah dokumen</label>
          <input
            id="dokumen-upload"
            type="file"
            disabled={busy}
            // The same allowlist the server enforces, so the file picker
            // filters rather than letting somebody choose a file that will be
            // refused after it uploads.
            accept={ALLOWED_DOCUMENT_TYPES.join(",")}
            onChange={handleUpload}
          />
          <label htmlFor="dokumen-members-only">
            <input
              id="dokumen-members-only"
              type="checkbox"
              checked={nextMembersOnly}
              disabled={busy}
              onChange={(event) => setNextMembersOnly(event.target.checked)}
            />
            Khusus anggota berbayar
          </label>
          <p className="muted">Maksimal {formatBytes(MAX_DOCUMENT_BYTES)} per berkas.</p>
        </div>
      ) : null}

      {actionError !== null ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {documents.length === 0 ? (
        <p className="empty">Belum ada dokumen.</p>
      ) : (
        <ul className="card-list dokumen-list">
          {documents.map((document) => (
            <li className="card dokumen-row" key={document.id}>
              <span className="dokumen-detail">
                <span className="dokumen-name">{document.name}</span>
                <span className="muted">
                  {formatBytes(document.byteSize)} · {formatRelativeTime(document.createdAt, clock)}
                </span>
              </span>
              {document.mayDownload ? (
                // A BUTTON, not a link — see `downloadCommunityDocument`. The
                // bytes are member-gated behind an `Authorization` header that
                // a plain navigation cannot carry, and the media cookie that
                // solves this for `<img src>` is scoped to `/users/media` on
                // purpose.
                <button type="button" disabled={busy} onClick={() => handleDownload(document)}>
                  Unduh
                </button>
              ) : (
                <span className="muted dokumen-locked">{lockReason(document, viewerIsMember)}</span>
              )}
              {viewerIsOwner ? (
                <button type="button" disabled={busy} onClick={() => handleDelete(document)}>
                  Hapus
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
