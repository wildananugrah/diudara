import { useState, type FormEvent } from "react";
import { MAX_COMMUNITY_TAGS, MAX_COMMUNITY_TAG_LENGTH } from "@diudara/shared";
import { updateCommunityTags } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";

interface Props {
  slug: string;
  initialTags: string[];
}

/**
 * The owner's tag editor, inside the "Keanggotaan" tab — not a tab of its
 * own, since tags are a settings concern and that tab is already where tier
 * settings live. Only ever mounted when `CommunityPage` already knows the
 * viewer is the owner, the same way `StatistikTab` is.
 *
 * Every change is a FULL REPLACE through `PATCH /communities/:slug/tags`,
 * never applied locally first: the server is what normalises (lowercase,
 * dedupe, strip a leading "#"), so the chips shown are always what the
 * server actually stored, not a client guess that might drift from it.
 */
export default function CommunityTagsEditor({ slug, initialTags }: Props) {
  const [tags, setTags] = useState(initialTags);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replace(next: string[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await updateCommunityTags(slug, next);
      setTags(result.tags);
    } catch (err: unknown) {
      setError(`Tag gagal disimpan. ${describeRequestFailure(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function handleAdd(event: FormEvent): void {
    event.preventDefault();
    const cleaned = draft.trim().slice(0, MAX_COMMUNITY_TAG_LENGTH);
    if (cleaned === "") return;
    setDraft("");
    void replace([...tags, cleaned]);
  }

  return (
    <section className="community-tags-editor">
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {tags.length === 0 ? (
        <p className="empty">Belum ada tag.</p>
      ) : (
        <p className="community-card-tags">
          {tags.map((tag) => (
            <span key={tag} className="badge badge-neutral">
              #{tag}
              <button
                type="button"
                disabled={busy}
                aria-label={`Hapus tag ${tag}`}
                onClick={() => void replace(tags.filter((t) => t !== tag))}
              >
                ×
              </button>
            </span>
          ))}
        </p>
      )}

      <form className="tag-form" onSubmit={handleAdd}>
        <label htmlFor="tag-draft">Tambah tag</label>
        <input
          id="tag-draft"
          value={draft}
          maxLength={MAX_COMMUNITY_TAG_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || draft.trim() === "" || tags.length >= MAX_COMMUNITY_TAGS}>
          Tambah
        </button>
      </form>
    </section>
  );
}
