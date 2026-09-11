# Phase 4a — Dokumen, the community document library

**Date:** 2026-09-11
**Programme:** `2026-09-09-udara-program-design.md`
**Follows:** Phase 3, `2026-09-11-community-events-design.md` (merged)
**Branch:** `feat/udara-documents`

## Goal

A community owner can upload files to their community. Anyone can see what is
there; members can download it.

That is the whole phase.

## Why Phase 4 is split

The programme's Phase 4 row reads "Materi + Dokumen — Syllabus, lesson viewer,
document library — new course/lesson + documents". Reading the reference
directly shows those are two systems, not two tabs, and the larger one
contains a decision no earlier phase has made.

**What the reference's Materi tab is.** `contentLibrary` in `mock.ts` is weeks
containing lessons typed `video`, `audio`, `ebook` and `quiz`, rendered in a
two-pane viewer with a video player, an audio player, a page count and a
ten-question quiz. That is a course platform: hosted video, hosted audio, a
document viewer and a quiz engine, each of which is its own phase-sized
problem.

**What the reference's Dokumen tab is.** `libraryFiles` is a flat list —
name, type, size, relative date, download button. One table, one upload path,
one download path.

**And the blocker between them.** `libraryFiles` includes `.mp4` entries at
**340 MB and 512 MB**. This repo's media pipeline caps uploads at 10 MB and —
deliberately, as `routes/media.ts` states at length — **proxies every byte
through the API** so the entitlement check cannot be outlived by a URL.
Half a gigabyte through a single-process Hono API is not that decision
scaling badly; it is that decision not applying, and the alternative
(presigned direct-to-bucket URLs) weakens the gate from "checked on every
request" to "whoever holds the URL for the next N minutes".

So **Phase 4a is Dokumen alone**, at a size the existing proxy handles
comfortably, with video explicitly out. **Phase 4b is Materi**, and it gets
its own spec — by which point there will be production evidence about what
file sizes this box actually sustains, which is a better input to the
presigned-URL decision than a guess made now.

## The schema

### `community_document`

```
id            uuid PRIMARY KEY
community_id  uuid NOT NULL REFERENCES community(id)
uploader_id   uuid NOT NULL REFERENCES app_user(id)
name          varchar(255) NOT NULL
content_type  varchar(128) NOT NULL
byte_size     integer NOT NULL
created_at    timestamptz NOT NULL DEFAULT now()
deleted_at    timestamptz
```

**`content_type` lives in this row, not in bucket metadata.** That single
choice is what keeps `DocumentStoragePort` trivial: no variant, no content
type on write, no metadata read on delivery. The delivery route already has
to read the row (to check the community and the gate), so the type comes free
with a lookup that was happening anyway.

**`uploader_id` is kept even though only an owner can upload today.** Owners
can change — Phase 1's `community.owner_id` is a column, not an identity —
and "who put this here" is not answerable afterwards from `community_id`
alone. It is also the field a future member-upload rule would need, without a
migration.

**`name` is the original filename**, sanitised (see **Filenames**). It is
display text and the download's suggested filename; it is never a path and
never part of a bucket key.

**`deleted_at` is a SOFT delete, matching `post`.** Every read path filters
it. The bytes are removed from the bucket on delete — unlike a post's images,
which `media-entitlement.ts` records are deliberately retained — because a
document has exactly one referent and no second surface that might still want
it.

### The index

```
index community_document_community_created_idx
  on (community_id, created_at desc)
  where deleted_at is null
```

Partial, so deleted rows leave the index entirely rather than being filtered
out of every scan — the shape `post_live_created_idx` already uses, and for
the same reason.

### No CHECK constraints

There is nothing here a CHECK can express that the write path does not
already decide: `byte_size` is measured from the bytes actually received, and
`content_type` is checked against a shared allowlist that a CHECK would have
to duplicate and then keep in step. Contrast `community_event`, where
`ends_at > starts_at` is a relationship between two stored columns and
therefore exactly what a CHECK is for.

### `RESERVED_COMMUNITY_SLUGS` is untouched

Every route below sits under `/communities/:slug/documents…`, so `documents`
never appears as the FIRST segment after `/communities`. A community slugged
`documents` shadows nothing. This is stated rather than left silent because
Phase 2 had to reserve `comments` for exactly the opposite shape, and "no
reservation needed here, and why" is worth recording once.

## Storage

A new port, beside `MediaStoragePort` rather than inside it:

```
DocumentStoragePort
  put(id, bytes)   -> void
  get(id)          -> Uint8Array | null
  remove(id)       -> void
```

**Why not widen `MediaStoragePort`.** Its signature is
`put(id, variant: "full" | "thumb", bytes)`, and its key is
`posts/${id}/${variant}.webp` — a shape that encodes "two derived variants of
a re-encoded image". A document has one object, is stored byte-for-byte as
uploaded, and carries a content type the image path derives from the
re-encoding. Adding a third variant would make `remove(id)` mean two
different things depending on what the id is.

The S3 adapter keys `documents/${id}` and mirrors
`S3MediaStorageAdapter`'s **method-level** network guard verbatim — the one
its docstring explains at length, which makes a real outbound call from a
test structurally impossible while still letting bootstrap-selection tests
construct the adapter to assert `instanceof`. A fake adapter mirrors
`FakeMediaStorageAdapter`.

## The security decision

**The uploaded content type is untrusted, and is not sniffed.**

We store bytes as they arrive, so `content_type` is whatever the client
declared. An attacker uploads an HTML file labelled `application/pdf`; if
that is ever served back in a way a browser renders, it is stored XSS on the
app's own origin, with a session cookie in scope.

Three measures close it, and they are held together rather than
individually:

1. **The allowlist has no `text/html` and no `image/svg+xml`.** SVG is
   excluded specifically because it executes script — it is an image
   everywhere except in the one way that matters here.
2. **Every download sends `Content-Disposition: attachment`,** with the
   row's `name` as the filename. The browser saves rather than renders, so
   even a correctly-labelled HTML file would not execute.
3. **Every download sends `X-Content-Type-Options: nosniff`,** so a browser
   cannot decide for itself that something labelled `application/pdf` looks
   like HTML and render it anyway. Without this, measure 1 is defeated by
   the browser's own helpfulness.

Magic-byte sniffing was considered and rejected: it needs a signature table
per accepted format, it is defeated by polyglot files, and it would still
need all three measures above. The images phase can validate by decoding
because sharp has to decode anyway; there is no equivalent free check here.

**`Cache-Control` is decided by the same check that decided the bytes**, the
rule `routes/media.ts` records: computed separately, the two can disagree,
and a shared cache then holds gated documents and serves them to strangers —
a failure no assertion on the status code would catch. Documents are
member-gated, so the header is the private one on every response.

## Filenames

`name` is sanitised on the way in, not on the way out:

- Any path separator or `..` is stripped — the value must never be able to
  read as a path, in a bucket key or a `Content-Disposition` or anywhere else.
- Control characters and newlines are stripped. A newline in a filename is a
  **header injection** into `Content-Disposition`, which is the one place
  this value reaches a header.
- Trimmed, and truncated to 255 characters.
- An empty result after all that is rejected, not defaulted — a file with no
  usable name is a caller error, and inventing `document.pdf` for it hides
  a bug.

The filename is also `filename*=UTF-8''…` percent-encoded in the header, so a
Bahasa or accented name survives rather than being mangled or dropped.

## The contract

`packages/shared/src/document.schema.ts` — a new module beside
`media.schema.ts`, and for the reason that file's own docstring gives: a
limit declared twice can drift, and drifting HIGH means the client promises
something the server refuses.

```
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
MAX_DOCUMENT_NAME_LENGTH = 255

ALLOWED_DOCUMENT_TYPES = {
  application/pdf
  application/msword
  application/vnd.openxmlformats-officedocument.wordprocessingml.document
  application/vnd.ms-excel
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
  application/vnd.ms-powerpoint
  application/vnd.openxmlformats-officedocument.presentationml.presentation
  text/plain
  text/csv
  image/png
  image/jpeg
  image/webp
}

DOCUMENT_ERROR_CODE = {
  missingFile:       "document_missing_file"
  tooLarge:          "document_too_large"
  unsupportedFormat: "document_unsupported_format"
  invalidName:       "document_invalid_name"
}
```

Codes on the wire, mirroring `UPLOAD_ERROR_CODE`, so the client's Bahasa copy
branches on a label rather than on a matched message — the failure
`errorCopy.ts` exists to prevent.

**No video and no audio types, and no archives.** Video is Phase 4b's
problem. Archives are excluded because a zip's contents are invisible to
every check above — the allowlist would be vouching for bytes it cannot see.

## The API

| Method | Path | Auth |
|---|---|---|
| `GET` | `/communities/:slug/documents` | none |
| `POST` | `/communities/:slug/documents` | owner |
| `GET` | `/communities/:slug/documents/:id` | **member** |
| `DELETE` | `/communities/:slug/documents/:id` | owner |

**The list is open; the bytes are not.** A non-member sees names, sizes and
dates — enough to judge whether a community is worth joining, which is
Phase 1's whole argument for open reading — and gets nothing when they ask
for content. This is the first gated surface in the programme, and it is the
natural hook for Phase 5's paid tiers: the check lives in one place, and
"member" becomes "member with an active tier" without moving it.

**A refused download is a 404, not a 403** — the rule `routes/media.ts`
already applies to gated media. A 403 confirms the document exists to
somebody who may not have it, and 404 is what this route already returns for
a document that is absent, so gated and absent look identical from outside.

**The byte route proxies by hand and MUST NOT become a redirect.** Read
`routes/media.ts`'s comment on `/media/:id` before changing it: a 302 to a
signed URL hands the caller something that outlives the check that produced
it, and the gate becomes a decision made once that the internet keeps
forever.

**Upload is `multipart/form-data`** with a `file` part, matching
`POST /users/media` exactly, including its ordering: `requireAuth` runs
BEFORE `bodyLimit`, because a body ceiling is a resource guard and a stranger
should be turned away before this process reasons about their body at all.

`DELETE` answers `{ deleted: true }` at **200**, the shape `deletePost` and
`deleteComment` already use (ruling R10). Deleting removes the bucket object
as well as soft-deleting the row.

### `CommunityDocumentView`

```
{ id, name, contentType, byteSize, createdAt,
  uploader: { handle, displayName } }
```

No URL. The id is the identifier, and the path is derived from it by the
client — the same rule `MediaView` records, which is what keeps a bucket URL
structurally unable to reach a response.

## Permissions

| Action | Who |
|---|---|
| List documents | anyone, signed out included |
| Download a document | members |
| Upload | the community's owner |
| Delete | the community's owner |

Owner-only upload takes the branch `pengumuman` and `kegiatan` already take —
`OWNER_ONLY_TYPES` in `community-feed.ts` is the precedent, and this is the
same rule applied to a different resource. A library any member can write to
is a moderation surface this phase has no moderation tools for.

## The web app

**A fourth tab: Dokumen**, at `?tab=dokumen`, beside Diskusi, Kegiatan and
Anggota. Only the active tab mounts, the rule the tab bar has kept since
Phase 2.

**The list is a card of rows** — an icon by extension, the name, `size ·
relative date`, and a trailing action. The action is what the viewer's
relationship earns:

- **member** → a download button
- **signed-in non-member** → the same `Gabung dulu` pointer the composer
  shows, aimed at the banner's join control
- **signed out** → the same, pointing at sign-in

Never a download control that would fail — the rule Phase 1 set when it cut
the tab bar rather than render tabs with nothing behind them.

**The owner additionally gets** a file input above the list and a delete on
each row. Delete confirms first, then sends, then removes the row — the
order `PostCard`'s `onDeleteRequested` docstring records, after that callback
was once named as though the row were already gone.

**The download is a real navigation, not `fetch`.** The response carries
`Content-Disposition: attachment`, so letting the browser handle it is what
produces a save dialogue with the right filename; fetching it into memory
and building a blob URL would reimplement that badly and hold 25 MB in the
tab. A member's download therefore goes through a plain link.

**`formatBytes`** is new and shared — `"2,4 MB"`, Indonesian decimal comma,
matching `api.ts`'s existing `id-ID` money formatting. It gets its own unit
test at the unit boundaries, where a rounding error is visible.

## Not in this phase

- **Materi, entirely** — Phase 4b: the syllabus, hosted video and audio, the
  ebook viewer and the quiz engine, plus the presigned-upload decision large
  media forces.
- **Folders or any hierarchy.** A flat list is what the reference shows.
- **Renaming, replacing or versioning a document.** Uploaded or deleted,
  the same shape comments shipped in.
- **Download counts.** The reference shows a `topDocuments` metric, but it
  lives on the CREATOR DASHBOARD, which is Phase 6. Counting downloads here
  would be building half of that phase's data model with no surface to read
  it.
- **Member uploads**, and any moderation beyond the owner's delete.
- **Virus scanning.** Worth saying out loud rather than leaving unmentioned:
  nothing here inspects file contents. The measures under **The security
  decision** stop the app's own origin being used against its users; they do
  not make a hostile `.docx` safe to open. A real answer is an external
  scanning service, which is a dependency and an operational cost this phase
  is not taking on.

## Testing

**The three security headers get a test that cannot pass by omission.** They
work as a set — the allowlist without `nosniff` is defeated by the browser's
own sniffing, and `nosniff` without `attachment` still renders a correctly
labelled HTML file. So one table-driven test asserts all three on a single
download response, rather than three tests that each happen to remember one.
A fourth measure added later joins the table.

**Filename sanitisation is tested at the hostile inputs, not the friendly
one.** `../../etc/passwd`, a name containing `\r\n`, a name that is only
separators, a 300-character name, and a Bahasa name with accents that must
survive the round trip into `filename*=UTF-8''…`. A test on
`"Rangkuman.pdf"` proves nothing about any of them.

**The gate gets both directions in one fixture** — a member downloads, a
non-member is refused, a signed-out visitor is refused, and all three can
list. One fixture, driven from a table, for the reason Phase 2 recorded when
a filter present on three paths and missing on the fourth went unnoticed:
each path's own test only ever created rows it was allowed to see.

**A refused upload writes nothing** — no row, and no bucket object. Asserted
against the fake storage's contents, not just the response status: an upload
that 400s after writing bytes leaves an orphan nothing will ever collect,
because the sweep that collects unclaimed `post_media` does not know about
this table.

Beyond that:

- Every existing community test stays green untouched — this phase adds a
  table and a tab and changes no shipped path.
- The route-table guard in `app.test.ts` and the tab-bar guard in
  `CommunityPage.test.tsx` both move deliberately, as they did in Phase 3.
- `formatBytes` is asserted at 0, at 1023 B, at exactly 1 MB, and at the cap.

Per the repo's standing rule the gate is `bun test` and `bun run typecheck`.
No Playwright run and no dev server is part of this phase's verification.

## Risks

**The 25 MB cap is a guess, and it is the number to revisit first.** It was
chosen as comfortably streamable by a single process, not measured on the
deploy box. `MAX_DOCUMENT_BYTES` is in one shared place precisely so
changing it is one line; if uploads at the cap prove heavy under concurrency,
that is the lever, and it is also the evidence Phase 4b needs for its own
presigned-URL decision.

**Deleting bytes on delete is not undoable.** A post's images survive their
post on purpose; a document's do not. That is the right default for a
library — a deleted file should stop existing — but it means an
accidental delete is permanent, and this phase ships no undo and no trash.
The owner's confirmation dialogue is the only thing standing in front of it.
