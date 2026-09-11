# Phase 4b — Materi, the syllabus

**Date:** 2026-09-12
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 8b, `2026-09-12-direct-messages-design.md` (merged)
**Branch:** `feat/udara-materi`

## Why this is buildable now, and what still is not

Phase 4a split Materi off and deferred it, saying the presigned-upload
decision would be better made "by which point there will be production
evidence about what file sizes this box actually sustains."

**There is still no such evidence.** Nothing has been deployed and used since,
so that deferral has not resolved itself and this spec does not pretend
otherwise. Hosted video and audio remain out.

What makes the phase buildable anyway is that **the structure is independent
of the media**. Sections containing ordered lessons, and a viewer for them,
needs no decision about large files at all. A lesson's *content* is where the
question lives, and this phase answers it with what already exists.

## What a lesson is

**A title, a body, and optionally one document from the community's Phase 4a
library.**

That is the decision this phase turns on. "Modul Kalkulus Dasar" is a lesson
whose body explains the week and whose attachment is the PDF — not a new
upload path. The library already owns uploading, the 25 MB cap, the format
allowlist, the `attachment`/`nosniff` headers and the members-only gate, so a
lesson inherits every one of them for free.

**Including the lock.** A lesson attaching a members-only document shows the
document as locked to a viewer without an active subscription, because the
gate is the document's and this phase does not add a second one. A lesson
itself is never gated — see **Reading is open**.

### The reference's four lesson types, and what happens to each

| Type | This phase |
|---|---|
| `ebook` | **Built** — a lesson with an attached PDF, which is what the document library already serves |
| `video` | **Not built** — the large-file decision Phase 4a deferred, still unresolved |
| `audio` | **Not built** — same |
| `quiz` | **Not built** — questions, options, answers, attempts and grading is a subsystem, not a lesson type |

The mockup's viewer is placeholder for all four: a gradient with a play icon,
a fake waveform, a centred card. Nothing plays or opens, because the mockup
has no backend. Building the two that cannot work would be building the
placeholder rather than the feature.

**No `type` column.** There is exactly one kind of lesson, and a column whose
only value is `"text"` is a column that invites somebody to add `"video"`
before anything can serve one. When video arrives it brings its own column
and its own migration.

## The schema

### `course_section`

```
id            uuid PRIMARY KEY
community_id  uuid NOT NULL REFERENCES community(id)
title         varchar(160) NOT NULL
position      integer NOT NULL
created_at    timestamptz NOT NULL DEFAULT now()

index course_section_community_position_idx on (community_id, position)
```

### `course_lesson`

```
id           uuid PRIMARY KEY
section_id   uuid NOT NULL REFERENCES course_section(id)
title        varchar(160) NOT NULL
body         text NOT NULL
document_id  uuid NULL REFERENCES community_document(id)
position     integer NOT NULL
created_at   timestamptz NOT NULL DEFAULT now()

index course_lesson_section_position_idx on (section_id, position)
```

**`position` is an integer the writer supplies, not a computed order.** A
syllabus is ordered by its author, not by when they happened to type it, and
`created_at` would make inserting a lesson between two others impossible
without rewriting timestamps.

**Ties are broken by `created_at`, then `id`.** Two lessons at the same
position is a state the schema permits and the ordering must therefore be
total — otherwise the syllabus reorders itself between page loads, which
looks like data loss to somebody reading it.

**`document_id` is nullable and is a real foreign key**, so a lesson cannot
reference a document that never existed. A document soft-deleted after being
attached still resolves — the join sees `deleted_at` and the lesson renders
without its attachment rather than with a broken one.

**No lesson count column.** The reference shows "6 materi" per week; that is
the real count, computed. A stored count is a second source of truth that
drifts the first time a lesson is added by any path that forgets it.

## Permissions

| Action | Who |
|---|---|
| Read the syllabus and a lesson | anyone, signed out included |
| Create, edit or delete a section | the community's owner |
| Create, edit or delete a lesson | the community's owner |

**Reading is open**, like the feed, the calendar, the document list and the
tier offer — Phase 1's argument that a community must be evaluable before
joining. The paid material is the attached document, and its gate is already
built.

**Owner-only authoring** takes the branch `pengumuman`, `kegiatan` and tier
management already take.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/communities/:slug/syllabus` | none |
| `POST` | `/communities/:slug/sections` | owner |
| `POST` | `/communities/:slug/lessons` | owner |
| `DELETE` | `/communities/:slug/lessons/:id` | owner |
| `DELETE` | `/communities/:slug/sections/:id` | owner |

**`GET .../syllabus` returns the whole tree in one response** — sections, their
lessons, and each lesson's attachment state. A syllabus is one screen; a
request per section would be a request per section.

**Lesson bodies ARE included**, and the alternative was weighed. Withholding
them would make the tree a pure menu and each lesson a second request — the
shape a feed uses for its images. A lesson body is a paragraph or two, a
syllabus is a dozen of them, and a round trip on every click to fetch a few
kilobytes is worse than sending them once. **Risks** records the size at which
that stops being true and what the lever is.

**Deleting a section deletes its lessons**, in one transaction. The
alternative — refusing while lessons remain — makes an owner delete a dozen
things to remove one, and orphaned lessons under no section would be
unreachable by every read path.

## The web app

**A sixth tab: Materi**, at `?tab=materi`, beside Diskusi, Kegiatan, Dokumen,
Keanggotaan, Anggota and (for the owner) Statistik.

Two panes: the syllabus on the left, the selected lesson on the right. **One
column on a phone** — the list, and choosing a lesson replaces it with the
lesson and a way back, the same shape the chat panel uses.

**The attachment renders through the document library's own rules.** A
downloadable attachment is a button that fetches with the authenticated
client (Phase 4a's `downloadCommunityDocument`); a locked one is the same
"Khusus anggota berbayar" pointer the Dokumen tab shows. Neither is
reimplemented here.

**An empty syllabus says so.** For the owner it says so beside the controls
to fix it; for everybody else it is a plain sentence.

## Not in this phase

- **Hosted video and audio.** The large-file decision is still unmade and
  still unevidenced.
- **The quiz engine.** Questions, options, answers, attempts, grading — a
  subsystem.
- **Progress or completion tracking.** Nothing records that somebody read a
  lesson. The reference shows none either.
- **Reordering from the UI.** `position` is settable on create; dragging a
  lesson to a new place is a separate interaction with its own persistence
  question, and an owner can delete and re-add in the meantime.
- **Editing a lesson's body.** Create and delete, the shape comments and
  events shipped in.
- **Attaching more than one document to a lesson.** One is the common case;
  a second would be a join table for a need nobody has stated.

## Testing

- **The ordering is total.** Two lessons at the same `position` come back in a
  stable order across repeated reads — asserted by reading twice and comparing,
  because a syllabus that reorders itself between page loads looks like data
  loss.
- **A lesson attached to a members-only document reports it as locked to a
  non-subscriber and downloadable to a subscriber** — one fixture holding an
  open document and a paid one, driven from a table. This is the seam between
  this phase and 4a and the place a second, weaker gate would appear.
- **A soft-deleted document leaves its lesson intact**, rendering without an
  attachment rather than with a broken one.
- **Deleting a section removes its lessons**, and nothing else's.
- **Another community's sections are absent** from this one's syllabus —
  one fixture, two communities, the shape every leak in this codebase has had.
- A non-owner is refused every write; reading is open to a signed-out visitor.
- The route-table and tab-bar guards move deliberately, as they have each
  phase.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.

## Risks

**This is the seventh tab on one page.** `CommunityPage` now carries Diskusi,
Kegiatan, Dokumen, Keanggotaan, Materi, Anggota and Statistik. That is past
the point where a tab bar is comfortable on a phone, and it is a design
problem this phase adds to rather than solves. Named here because the next
person to add a tab should be making a different decision instead.

**The syllabus response grows with the course.** Bodies are included, and a
course with two hundred lessons would ship all of them to render a menu. At
the sizes this product has that is nothing; the lever, when it matters, is
splitting the tree from the bodies — which is why the tree is a separate
concept in the response rather than a flat list.
