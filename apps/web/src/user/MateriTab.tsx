import { useEffect, useState } from "react";
import { ALLOWED_DOCUMENT_TYPES, MAX_DOCUMENT_BYTES, isAllowedDocumentType } from "@diudara/shared";
import {
  createLesson,
  createSection,
  deleteLesson,
  deleteSection,
  downloadCommunityDocument,
  getSyllabus,
  uploadCommunityDocument,
  type LessonRow,
  type SectionRow,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { formatBytes } from "./formatBytes";

interface Props {
  slug: string;
  viewerIsOwner: boolean;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

/**
 * The **Materi** tab — a community's syllabus and its lesson viewer.
 *
 * **Two panes on a wide screen, one on a phone.** Narrow, the syllabus is the
 * screen and choosing a lesson replaces it with a way back — the shape the
 * chat panel uses, and the reason there is a single `selected` rather than
 * two independent layouts.
 *
 * **Nothing here gates anything.** A lesson is always readable; the paid
 * material is its ATTACHED DOCUMENT, and that lock is Phase 4a's, reported by
 * the server and rendered with Phase 4a's own download.
 *
 * **Card-styled to match the reference syllabus design** — numbered section
 * cards, a bordered lesson list, and a "materi selanjutnya" quick link in the
 * viewer, all derived from data this tab already has. Deliberately NOT
 * matched further: the reference's per-lesson type icons (video/audio/quiz),
 * durations and completion state have no backing field on `LessonRow` — this
 * app has one kind of lesson (title, body, an optional document), so those
 * are skipped rather than invented.
 */
export default function MateriTab({ slug, viewerIsOwner }: Props) {
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<LessonRow | null>(null);
  // Separate from `load`: a failed authoring action must not replace the
  // syllabus with an error page — it is still there and still readable.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    try {
      const page = await getSyllabus(slug);
      setSections(page.sections);
      setLoad({ status: "ready" });
    } catch (error: unknown) {
      setLoad({ status: "error", message: describeRequestFailure(error) });
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    getSyllabus(slug)
      .then((page) => {
        if (cancelled) return;
        setSections(page.sections);
        setLoad({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: describeRequestFailure(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleDownload(lesson: LessonRow): Promise<void> {
    if (lesson.attachment === null) return;
    setBusy(true);
    setActionError(null);
    try {
      // Phase 4a's own download — an authenticated fetch, never a bare link,
      // because the bytes are gated behind a Bearer header a navigation
      // cannot carry.
      await downloadCommunityDocument(slug, lesson.attachment.documentId, lesson.attachment.name);
    } catch (error: unknown) {
      setActionError(`Lampiran gagal diunduh. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function addSection(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const title = (form.elements.namedItem("section-title") as HTMLInputElement).value;
    setBusy(true);
    setActionError(null);
    try {
      await createSection(slug, { title, position: sections.length + 1 });
      form.reset();
      await refresh();
    } catch (error: unknown) {
      setActionError(`Bagian gagal dibuat. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function addLesson(
    sectionId: string,
    title: string,
    body: string,
    documentId?: string
  ): Promise<void> {
    const section = sections.find((row) => row.id === sectionId);
    setBusy(true);
    setActionError(null);
    try {
      await createLesson(slug, {
        sectionId,
        title,
        body,
        position: (section?.lessonCount ?? 0) + 1,
        ...(documentId === undefined ? {} : { documentId }),
      });
      await refresh();
    } catch (error: unknown) {
      setActionError(`Materi gagal dibuat. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The empty-syllabus path: `SectionAuthoring`'s dropzone lives inside a
   * SECTION's card, so a community with none yet shows no way to attach
   * anything — a section title, a lesson and its attachment are one screen
   * here instead of "create a bare section, then find its form".
   */
  async function addFirstLesson(
    sectionTitle: string,
    title: string,
    body: string,
    documentId?: string
  ): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const section = await createSection(slug, { title: sectionTitle, position: 1 });
      await createLesson(slug, {
        sectionId: section.id,
        title,
        body,
        position: 1,
        ...(documentId === undefined ? {} : { documentId }),
      });
      await refresh();
    } catch (error: unknown) {
      setActionError(`Materi gagal dibuat. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeSection(section: SectionRow): Promise<void> {
    if (
      !window.confirm(
        `Hapus ${section.title}? ${section.lessonCount} materi di dalamnya ikut terhapus.`
      )
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await deleteSection(slug, section.id);
      setSelected(null);
      await refresh();
    } catch (error: unknown) {
      setActionError(`Bagian gagal dihapus. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeLesson(lesson: LessonRow): Promise<void> {
    if (!window.confirm(`Hapus ${lesson.title}?`)) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteLesson(slug, lesson.id);
      if (selected?.id === lesson.id) setSelected(null);
      await refresh();
    } catch (error: unknown) {
      setActionError(`Materi gagal dihapus. ${describeRequestFailure(error)}`);
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

  // The section the selected lesson lives in, and its own next sibling —
  // both derived from `sections`, already in hand from the one fetch above.
  // No second read: `SectionRow.lessons` is already position-ordered.
  const selectedSection =
    selected === null ? null : sections.find((row) => row.lessons.some((l) => l.id === selected.id)) ?? null;
  const nextLesson =
    selectedSection === null || selected === null
      ? null
      : (selectedSection.lessons[selectedSection.lessons.findIndex((l) => l.id === selected.id) + 1] ?? null);

  return (
    <section className="materi-tab" data-viewing={selected === null ? undefined : "lesson"}>
      {actionError !== null ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}

      <div className="materi-syllabus">
        {sections.length === 0 ? (
          <p className="empty">Belum ada materi.</p>
        ) : (
          sections.map((section, index) => (
            <div className="materi-section" key={section.id}>
              <div className="materi-section-head">
                <span className="materi-section-index">{index + 1}</span>
                <div className="materi-section-heading">
                  <h4>{section.title}</h4>
                  <span className="materi-section-count muted">{section.lessonCount} materi</span>
                </div>
              </div>
              <ul className="materi-lesson-list">
                {section.lessons.map((lesson) => (
                  <li className="materi-lesson-row" key={lesson.id}>
                    <button
                      type="button"
                      className="materi-lesson-button"
                      aria-current={selected?.id === lesson.id}
                      onClick={() => setSelected(lesson)}
                    >
                      {lesson.title}
                      {/* The lock is the DOCUMENT's, reported by the server —
                          this tab adds no gate of its own. */}
                      {lesson.attachment?.membersOnly === true ? (
                        <span className="muted"> · berbayar</span>
                      ) : null}
                    </button>
                    {viewerIsOwner ? (
                      <button
                        type="button"
                        className="button-quiet"
                        disabled={busy}
                        onClick={() => removeLesson(lesson)}
                      >
                        Hapus
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
              {viewerIsOwner ? (
                <SectionAuthoring
                  slug={slug}
                  busy={busy}
                  onAdd={(title, body, documentId) => addLesson(section.id, title, body, documentId)}
                  onRemove={() => removeSection(section)}
                />
              ) : null}
            </div>
          ))
        )}

        {viewerIsOwner ? (
          sections.length === 0 ? (
            <FirstSectionAuthoring slug={slug} busy={busy} onAdd={addFirstLesson} />
          ) : (
            <form className="materi-form materi-form-section" onSubmit={addSection}>
              <label htmlFor="section-title">Bagian baru</label>
              <input id="section-title" name="section-title" maxLength={160} required />
              <button type="submit" disabled={busy}>
                Tambah bagian
              </button>
            </form>
          )
        ) : null}
      </div>

      <div className="materi-viewer">
        {selected === null ? (
          <p className="muted">Pilih materi untuk membaca.</p>
        ) : (
          <>
            <button
              type="button"
              className="materi-back"
              onClick={() => setSelected(null)}
            >
              Kembali
            </button>
            {selectedSection !== null ? (
              <p className="materi-viewer-eyebrow muted">{selectedSection.title}</p>
            ) : null}
            <h4>{selected.title}</h4>
            {/* A plain text node, never dangerouslySetInnerHTML — the rule
                `PostCard` records for this class of untrusted input. */}
            <p className="materi-body">{selected.body}</p>

            {selected.attachment === null ? null : selected.attachment.membersOnly ? (
              // Never a control for an action that would fail: the server
              // would 404 these bytes for a non-subscriber, so this points at
              // what would fix it instead.
              <p className="muted">
                Lampiran khusus anggota berbayar — {selected.attachment.name}
              </p>
            ) : (
              <button
                type="button"
                className="materi-attachment"
                disabled={busy}
                onClick={() => handleDownload(selected)}
              >
                Unduh {selected.attachment.name} ({formatBytes(selected.attachment.byteSize)})
              </button>
            )}

            {nextLesson !== null ? (
              <button
                type="button"
                className="materi-next"
                onClick={() => setSelected(nextLesson)}
              >
                <span className="muted">Materi selanjutnya</span>
                <span>{nextLesson.title}</span>
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The owner's per-section controls. Split out so the list above stays
 * readable.
 *
 * **The attachment dropzone is `DokumenTab`'s own — copied, not shared**, for
 * the reason `dashboard/apiClient.ts`'s own docstring gives for its sibling
 * copies: this form uploads eagerly (the file becomes a real community
 * document, with its own `documentId`, the moment it is dropped or picked),
 * then carries that id into `onAdd` when the lesson itself is submitted. A
 * file dropped and never followed by a submit is simply an unattached
 * document in the library — the same "unclaimed until named" contract
 * `uploadMedia`'s own docstring records for a post's images.
 */
function SectionAuthoring({
  slug,
  busy,
  onAdd,
  onRemove,
}: {
  slug: string;
  busy: boolean;
  onAdd: (title: string, body: string, documentId?: string) => void;
  onRemove: () => void;
}) {
  const [attachment, setAttachment] = useState<{ id: string; name: string } | null>(null);
  const [attachMembersOnly, setAttachMembersOnly] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Purely a highlight while a file is dragged over the dropzone — the drop
  // itself goes through the same `processFile` path as the file input, so
  // this never gates an upload, only a CSS class. Mirrors `DokumenTab`'s own.
  const [isDragging, setIsDragging] = useState(false);
  const attachmentBusy = busy || attaching;

  async function processFile(file: File): Promise<void> {
    // Same courtesy check `DokumenTab.processFile` runs, and the same
    // shared-constant limits — the server remains the authority either way.
    if (file.size > MAX_DOCUMENT_BYTES) {
      setAttachError(`Berkas terlalu besar. Batasnya ${formatBytes(MAX_DOCUMENT_BYTES)}.`);
      return;
    }
    if (!isAllowedDocumentType(file.type)) {
      setAttachError("Format berkas tidak didukung.");
      return;
    }

    setAttaching(true);
    setAttachError(null);
    try {
      const created = await uploadCommunityDocument(slug, file, attachMembersOnly);
      setAttachment({ id: created.id, name: created.name });
    } catch (error: unknown) {
      setAttachError(`Lampiran gagal diunggah. ${describeRequestFailure(error)}`);
    } finally {
      setAttaching(false);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (attachmentBusy) return;
    setIsDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    // Only the outer dropzone leaving counts — a child element (the label,
    // the checkbox) firing its own dragleave must not cancel the highlight
    // while the pointer is still over the dropzone.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setIsDragging(false);
    if (attachmentBusy) return;
    const file = event.dataTransfer.files[0];
    if (file === undefined) return;
    await processFile(file);
  }

  async function handlePick(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    // Clear the input immediately so choosing the SAME file twice after a
    // failure still fires a change event.
    event.target.value = "";
    if (file === undefined) return;
    await processFile(file);
  }

  return (
    <form
      className="materi-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.target as HTMLFormElement;
        const title = (form.elements.namedItem("lesson-title") as HTMLInputElement).value;
        const body = (form.elements.namedItem("lesson-body") as HTMLTextAreaElement).value;
        onAdd(title, body, attachment?.id);
        form.reset();
        setAttachment(null);
        setAttachMembersOnly(false);
        setAttachError(null);
      }}
    >
      <label htmlFor="lesson-title">Judul materi</label>
      <input id="lesson-title" name="lesson-title" maxLength={160} required />
      <label htmlFor="lesson-body">Isi materi</label>
      <textarea id="lesson-body" name="lesson-body" rows={3} required />

      <div
        className={`dokumen-upload${isDragging ? " dokumen-upload-dragging" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
      >
        <p className="dokumen-upload-prompt" aria-hidden="true">
          <span className="dokumen-upload-prompt-icon">↑</span>
          Seret berkas ke sini, atau klik untuk memilih
        </p>
        <label htmlFor="lesson-attachment">Lampiran (opsional)</label>
        <input
          id="lesson-attachment"
          type="file"
          disabled={attachmentBusy}
          // The same allowlist the server enforces, so the file picker
          // filters rather than letting somebody choose a file that will be
          // refused after it uploads.
          accept={ALLOWED_DOCUMENT_TYPES.join(",")}
          onChange={(event) => void handlePick(event)}
        />
        <label htmlFor="lesson-attachment-members-only">
          <input
            id="lesson-attachment-members-only"
            type="checkbox"
            checked={attachMembersOnly}
            disabled={attachmentBusy}
            onChange={(event) => setAttachMembersOnly(event.target.checked)}
          />
          Khusus anggota berbayar
        </label>
        <p className="muted">
          {attachment !== null
            ? `Terlampir: ${attachment.name}`
            : `Maksimal ${formatBytes(MAX_DOCUMENT_BYTES)} per berkas.`}
        </p>
        {attachError !== null ? (
          <p className="form-error" role="alert">
            {attachError}
          </p>
        ) : null}
      </div>

      <div className="materi-form-actions">
        <button type="submit" disabled={busy}>
          Tambah materi
        </button>
        <button type="button" className="button-quiet" disabled={busy} onClick={onRemove}>
          Hapus bagian
        </button>
      </div>
    </form>
  );
}

/**
 * The empty-syllabus form — `SectionAuthoring`'s own dropzone, copied rather
 * than shared for the same reason its docstring gives, plus one field: there
 * is no section yet for a lesson to belong to, so this asks for its title
 * too and `addFirstLesson` creates both in order.
 *
 * No "Hapus bagian" here — nothing exists yet to remove.
 */
function FirstSectionAuthoring({
  slug,
  busy,
  onAdd,
}: {
  slug: string;
  busy: boolean;
  onAdd: (sectionTitle: string, title: string, body: string, documentId?: string) => void;
}) {
  const [attachment, setAttachment] = useState<{ id: string; name: string } | null>(null);
  const [attachMembersOnly, setAttachMembersOnly] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const attachmentBusy = busy || attaching;

  async function processFile(file: File): Promise<void> {
    if (file.size > MAX_DOCUMENT_BYTES) {
      setAttachError(`Berkas terlalu besar. Batasnya ${formatBytes(MAX_DOCUMENT_BYTES)}.`);
      return;
    }
    if (!isAllowedDocumentType(file.type)) {
      setAttachError("Format berkas tidak didukung.");
      return;
    }

    setAttaching(true);
    setAttachError(null);
    try {
      const created = await uploadCommunityDocument(slug, file, attachMembersOnly);
      setAttachment({ id: created.id, name: created.name });
    } catch (error: unknown) {
      setAttachError(`Lampiran gagal diunggah. ${describeRequestFailure(error)}`);
    } finally {
      setAttaching(false);
    }
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (attachmentBusy) return;
    setIsDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setIsDragging(false);
    if (attachmentBusy) return;
    const file = event.dataTransfer.files[0];
    if (file === undefined) return;
    await processFile(file);
  }

  async function handlePick(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    await processFile(file);
  }

  return (
    <form
      className="materi-form materi-form-section"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.target as HTMLFormElement;
        const sectionTitle = (form.elements.namedItem("first-section-title") as HTMLInputElement)
          .value;
        const title = (form.elements.namedItem("first-lesson-title") as HTMLInputElement).value;
        const body = (form.elements.namedItem("first-lesson-body") as HTMLTextAreaElement).value;
        onAdd(sectionTitle, title, body, attachment?.id);
        form.reset();
        setAttachment(null);
        setAttachMembersOnly(false);
        setAttachError(null);
      }}
    >
      <label htmlFor="first-section-title">Bagian baru</label>
      <input id="first-section-title" name="first-section-title" maxLength={160} required />
      <label htmlFor="first-lesson-title">Judul materi</label>
      <input id="first-lesson-title" name="first-lesson-title" maxLength={160} required />
      <label htmlFor="first-lesson-body">Isi materi</label>
      <textarea id="first-lesson-body" name="first-lesson-body" rows={3} required />

      <div
        className={`dokumen-upload${isDragging ? " dokumen-upload-dragging" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(event) => void handleDrop(event)}
      >
        <p className="dokumen-upload-prompt" aria-hidden="true">
          <span className="dokumen-upload-prompt-icon">↑</span>
          Seret berkas ke sini, atau klik untuk memilih
        </p>
        <label htmlFor="first-lesson-attachment">Lampiran (opsional)</label>
        <input
          id="first-lesson-attachment"
          type="file"
          disabled={attachmentBusy}
          accept={ALLOWED_DOCUMENT_TYPES.join(",")}
          onChange={(event) => void handlePick(event)}
        />
        <label htmlFor="first-lesson-attachment-members-only">
          <input
            id="first-lesson-attachment-members-only"
            type="checkbox"
            checked={attachMembersOnly}
            disabled={attachmentBusy}
            onChange={(event) => setAttachMembersOnly(event.target.checked)}
          />
          Khusus anggota berbayar
        </label>
        <p className="muted">
          {attachment !== null
            ? `Terlampir: ${attachment.name}`
            : `Maksimal ${formatBytes(MAX_DOCUMENT_BYTES)} per berkas.`}
        </p>
        {attachError !== null ? (
          <p className="form-error" role="alert">
            {attachError}
          </p>
        ) : null}
      </div>

      <button type="submit" disabled={busy}>
        Tambah materi
      </button>
    </form>
  );
}
