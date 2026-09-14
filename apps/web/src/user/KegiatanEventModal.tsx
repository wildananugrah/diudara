import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { MAX_EVENT_LOCATION_LENGTH, MAX_EVENT_TITLE_LENGTH, MAX_POST_BODY_LENGTH } from "@diudara/shared";
import {
  createCommunityPost,
  deletePost,
  editPost,
  getPost,
  isOwnHandle,
  type CommunityEventRow,
  type EventDraft,
  type PostView,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { wibDateInputValue, wibDateLabel, wibTimeInputValue, wibTimeLabel, wibWallClockToIso } from "./wibDate";
import Modal from "./shell/Modal";

type Target =
  | { mode: "create"; date: string }
  | { mode: "detail"; postId: string };

interface Props {
  slug: string;
  target: Target;
  onClose: () => void;
  onCreated: (event: CommunityEventRow) => void;
  onUpdated: (event: CommunityEventRow) => void;
  onDeleted: (postId: string) => void;
}

/** `PostView` → the calendar's own row shape — both callers already have a full `PostView` (create's or edit's own response), never a second read. */
function toEventRow(post: PostView): CommunityEventRow {
  const event = post.event;
  return {
    postId: post.id,
    title: event?.title ?? "",
    startsAt: event?.startsAt ?? post.createdAt,
    endsAt: event?.endsAt ?? null,
    location: event?.location ?? null,
    author: post.author,
  };
}

interface FormValues {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  body: string;
}

function blankForm(date: string): FormValues {
  return { title: "", date, startTime: "", endTime: "", location: "", body: "" };
}

function formFromPost(post: PostView): FormValues {
  const event = post.event;
  return {
    title: event?.title ?? "",
    date: event === null || event === undefined ? "" : wibDateInputValue(event.startsAt),
    startTime: event === null || event === undefined ? "" : wibTimeInputValue(event.startsAt),
    endTime: event?.endsAt === null || event?.endsAt === undefined ? "" : wibTimeInputValue(event.endsAt),
    location: event?.location ?? "",
    body: post.body,
  };
}

/**
 * Mirrors `PostComposer`'s own `eventDraft()` — same rules, same reasoning
 * (see that function's docstring): `null` on anything that is not yet a
 * postable schedule, which is what keeps the submit button disabled rather
 * than sending a half-filled form.
 */
function buildEventDraft(form: FormValues): EventDraft | null {
  const title = form.title.trim();
  const startsAt = wibWallClockToIso(form.date, form.startTime);
  if (title.length === 0 || startsAt === null) return null;
  const endsAt = form.endTime === "" ? null : wibWallClockToIso(form.date, form.endTime);
  if (form.endTime !== "" && (endsAt === null || endsAt <= startsAt)) return null;
  const location = form.location.trim();
  return {
    title,
    startsAt,
    ...(endsAt === null ? {} : { endsAt }),
    ...(location === "" ? {} : { location }),
  };
}

/**
 * One modal for the Kegiatan tab's whole add/view/edit/delete flow —
 * `target.mode === "create"` opens blank, seeded with the WIB date the caller
 * clicked; `"detail"` fetches that post and shows it read-only first, with
 * Edit/Hapus for whoever may use them.
 *
 * **Local state only — `KegiatanTab` owns the calendar's `events` array.**
 * Every successful write calls back with a `CommunityEventRow` built from the
 * server's own response (never a second read) and closes; the tab decides how
 * to fold that into its list. Kegiatan creation is owner-only (spec — see
 * `OWNER_ONLY_TYPES` in `community-feed.ts`), so `KegiatanTab` only ever opens
 * `"create"` for an owner; this component does not re-check that itself.
 */
export default function KegiatanEventModal({ slug, target, onClose, onCreated, onUpdated, onDeleted }: Props) {
  const [post, setPost] = useState<PostView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Detail mode starts read-only; Edit flips this. Create mode has no
  // "view" state to flip from.
  const [editing, setEditing] = useState(target.mode === "create");
  const [form, setForm] = useState<FormValues>(target.mode === "create" ? blankForm(target.date) : blankForm(""));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (target.mode !== "detail") return;
    let cancelled = false;
    getPost(target.postId)
      .then((loaded) => {
        if (cancelled) return;
        setPost(loaded);
        setForm(formFromPost(loaded));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(describeRequestFailure(err));
      });
    return () => {
      cancelled = true;
    };
    // `target.mode` only, not `target.postId` — safe because `KegiatanTab`
    // renders AT MOST ONE of these at a time and only ever reaches a
    // different `target` by first setting it to `null` (closing this one,
    // unmounting it) and then opening a fresh instance. Two different
    // `postId`s therefore never appear to the SAME mounted instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.mode]);

  const draft = buildEventDraft(form);
  const trimmedBody = form.body.trim();
  const canSubmit = draft !== null && trimmedBody.length > 0 && trimmedBody.length <= MAX_POST_BODY_LENGTH && !saving;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (draft === null || !canSubmit) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (target.mode === "create") {
        const created = await createCommunityPost(slug, { body: trimmedBody, type: "kegiatan", event: draft });
        onCreated(toEventRow(created));
      } else {
        const updated = await editPost(target.postId, trimmedBody, undefined, undefined, draft);
        onUpdated(toEventRow(updated));
      }
      onClose();
    } catch (err: unknown) {
      setSaveError(describeRequestFailure(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(postId: string): Promise<void> {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deletePost(postId);
      onDeleted(postId);
      onClose();
    } catch (err: unknown) {
      setDeleteError(describeRequestFailure(err));
      setDeleting(false);
    }
  }

  const title = target.mode === "create" ? "Tambah kegiatan" : editing ? "Ubah kegiatan" : "Kegiatan";

  return (
    <Modal onClose={onClose} labelledBy="kegiatan-modal-title">
      <div className="modal-header">
        <h2 id="kegiatan-modal-title">{title}</h2>
        <button type="button" className="button-quiet" onClick={onClose} aria-label="Tutup">
          ✕
        </button>
      </div>

      {target.mode === "detail" && post === null ? (
        loadError !== null ? (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        ) : (
          <p>Memuat...</p>
        )
      ) : target.mode === "detail" && !editing && post !== null ? (
        <KegiatanDetailView
          post={post}
          onEdit={() => setEditing(true)}
          onDeleteRequested={() => setConfirmingDelete(true)}
          confirmingDelete={confirmingDelete}
          onCancelDelete={() => setConfirmingDelete(false)}
          onConfirmDelete={() => void handleDelete(post.id)}
          deleting={deleting}
          deleteError={deleteError}
          slug={slug}
        />
      ) : (
        <form onSubmit={handleSubmit} className="stack kegiatan-event-form">
          <Field label="Judul kegiatan" name="kegiatan-title">
            <input
              id="field-kegiatan-title"
              type="text"
              value={form.title}
              maxLength={MAX_EVENT_TITLE_LENGTH}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </Field>
          <Field label="Tanggal" name="kegiatan-date">
            <input
              id="field-kegiatan-date"
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </Field>
          <Field label="Waktu mulai" name="kegiatan-start">
            <input
              id="field-kegiatan-start"
              type="time"
              value={form.startTime}
              onChange={(e) => setForm({ ...form, startTime: e.target.value })}
            />
          </Field>
          <Field label="Waktu selesai" name="kegiatan-end" hint="Opsional.">
            <input
              id="field-kegiatan-end"
              type="time"
              value={form.endTime}
              onChange={(e) => setForm({ ...form, endTime: e.target.value })}
            />
          </Field>
          <Field label="Lokasi" name="kegiatan-location" hint="Opsional.">
            <input
              id="field-kegiatan-location"
              type="text"
              value={form.location}
              maxLength={MAX_EVENT_LOCATION_LENGTH}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </Field>
          <Field label="Deskripsi" name="kegiatan-body">
            <textarea
              id="field-kegiatan-body"
              value={form.body}
              maxLength={MAX_POST_BODY_LENGTH}
              rows={3}
              onChange={(e) => setForm({ ...form, body: e.target.value.slice(0, MAX_POST_BODY_LENGTH) })}
            />
          </Field>

          <div className="modal-actions">
            {target.mode === "detail" ? (
              <button type="button" className="button-quiet" onClick={() => setEditing(false)}>
                Batal
              </button>
            ) : null}
            <button type="submit" className="button-primary" disabled={!canSubmit}>
              {saving ? "Menyimpan..." : target.mode === "create" ? "Buat kegiatan" : "Simpan"}
            </button>
          </div>

          {saveError !== null ? (
            <p className="form-error" role="alert">
              {saveError}
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}

/** The local field wrapper — same reason `CoBuilderModal`'s own copy gives for keeping this un-shared. */
function Field({
  label,
  name,
  hint,
  children,
}: {
  label: string;
  name: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      {children}
      {hint !== undefined ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

function KegiatanDetailView({
  post,
  onEdit,
  onDeleteRequested,
  confirmingDelete,
  onCancelDelete,
  onConfirmDelete,
  deleting,
  deleteError,
  slug,
}: {
  post: PostView;
  onEdit: () => void;
  onDeleteRequested: () => void;
  confirmingDelete: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  deleting: boolean;
  deleteError: string | null;
  slug: string;
}) {
  const event = post.event;
  const mayEdit = isOwnHandle(post.author.handle);
  return (
    <div className="stack kegiatan-detail">
      <h3 className="kegiatan-detail-title">{event?.title ?? post.body}</h3>
      {event !== null && event !== undefined ? (
        <p className="muted">
          {wibDateAndTimeLabel(event.startsAt, event.endsAt)}
          {event.location === null ? "" : ` · ${event.location}`}
        </p>
      ) : null}
      <p className="kegiatan-detail-body">{post.body}</p>
      <p className="muted">
        Oleh {post.author.displayName} (@{post.author.handle})
      </p>

      {confirmingDelete ? (
        <div className="delete-confirm">
          <p>Yakin ingin menghapus kegiatan ini?</p>
          <div className="modal-actions">
            <button type="button" className="button-quiet" onClick={onCancelDelete} disabled={deleting}>
              Batal
            </button>
            <button type="button" className="button-danger" onClick={onConfirmDelete} disabled={deleting}>
              {deleting ? "Menghapus..." : "Ya, hapus"}
            </button>
          </div>
          {deleteError !== null ? (
            <p className="form-error" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="modal-actions">
          {mayEdit ? (
            <button type="button" className="button-quiet" onClick={onEdit}>
              Edit
            </button>
          ) : null}
          {mayEdit ? (
            <button type="button" className="button-quiet" onClick={onDeleteRequested}>
              Hapus
            </button>
          ) : null}
        </div>
      )}

      <a href={`/komunitas/${encodeURIComponent(slug)}/kegiatan/${encodeURIComponent(post.id)}`}>
        Lihat diskusi &amp; komentar
      </a>
    </div>
  );
}

/** `"15 September 2026, 16.00–18.00 WIB"` — one caller, local to this modal's detail view. */
function wibDateAndTimeLabel(startsAt: string, endsAt: string | null): string {
  const date = wibDateLabel(startsAt);
  const time = endsAt === null ? wibTimeLabel(startsAt) : `${wibTimeLabel(startsAt)}–${wibTimeLabel(endsAt)}`;
  return `${date}, ${time}`;
}
