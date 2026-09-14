import { useEffect, useState } from "react";
import {
  createLesson,
  createSection,
  deleteLesson,
  deleteSection,
  downloadCommunityDocument,
  getSyllabus,
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

  async function addLesson(sectionId: string, title: string, body: string): Promise<void> {
    const section = sections.find((row) => row.id === sectionId);
    setBusy(true);
    setActionError(null);
    try {
      await createLesson(slug, {
        sectionId,
        title,
        body,
        position: (section?.lessonCount ?? 0) + 1,
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
                  busy={busy}
                  onAdd={(title, body) => addLesson(section.id, title, body)}
                  onRemove={() => removeSection(section)}
                />
              ) : null}
            </div>
          ))
        )}

        {viewerIsOwner ? (
          <form className="materi-form materi-form-section" onSubmit={addSection}>
            <label htmlFor="section-title">Bagian baru</label>
            <input id="section-title" name="section-title" maxLength={160} required />
            <button type="submit" disabled={busy}>
              Tambah bagian
            </button>
          </form>
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

/** The owner's per-section controls. Split out so the list above stays readable. */
function SectionAuthoring({
  busy,
  onAdd,
  onRemove,
}: {
  busy: boolean;
  onAdd: (title: string, body: string) => void;
  onRemove: () => void;
}) {
  return (
    <form
      className="materi-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.target as HTMLFormElement;
        const title = (form.elements.namedItem("lesson-title") as HTMLInputElement).value;
        const body = (form.elements.namedItem("lesson-body") as HTMLTextAreaElement).value;
        onAdd(title, body);
        form.reset();
      }}
    >
      <label htmlFor="lesson-title">Judul materi</label>
      <input id="lesson-title" name="lesson-title" maxLength={160} required />
      <label htmlFor="lesson-body">Isi materi</label>
      <textarea id="lesson-body" name="lesson-body" rows={3} required />
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
