import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
  COMMUNITY_CATEGORIES,
  MAX_COMMUNITY_DESCRIPTION_LENGTH,
  MAX_COMMUNITY_NAME_LENGTH,
  MAX_COMMUNITY_TAGS,
  MAX_COMMUNITY_TAG_LENGTH,
} from "@diudara/shared";
import { createCommunity, getSessionUser } from "./apiClient";
import { describeCommunityFailure } from "./errorCopy";
import Header from "./shell/Header";

/**
 * The rest of the normalising (lowercase, dedupe, strip a leading "#") is the
 * server's — `communityTagsSchema` owns that so create and edit agree. This
 * only shapes the ONE input this page has that the schema does not: one text
 * field of comma-separated tags rather than an array.
 */
function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim().slice(0, MAX_COMMUNITY_TAG_LENGTH))
    .filter((tag) => tag !== "")
    .slice(0, MAX_COMMUNITY_TAGS);
}

/**
 * `/komunitas/baru` — *Buat komunitas*.
 *
 * **`baru` is a RESERVED SLUG** (`apps/api/src/domain/community-slug.ts`), so
 * no community can ever take this URL out from under the form. That reservation
 * is what makes a literal route safe here rather than merely likely to work.
 *
 * A signed-out visitor is redirected rather than shown a form that would 401
 * on submit — the same rule the join control on `CommunityPage` follows.
 *
 * **A failed submit keeps every field.** The most likely failure by far is a
 * name somebody already took, and the fix for it is one edit to one field;
 * clearing the form would make the user retype a description to change a word
 * in a name.
 */
export default function CommunityCreatePage() {
  const navigate = useNavigate();
  const signedIn = getSessionUser() !== null;
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!signedIn) {
    return <Navigate to="/masuk" replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setSubmitting(true);
    try {
      const created = await createCommunity({
        name: name.trim(),
        category,
        description: description.trim() === "" ? undefined : description.trim(),
        tags: parseTags(tags),
      });
      navigate(`/komunitas/${created.slug}`);
    } catch (err) {
      setMessage(describeCommunityFailure(err));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Header title="Buat komunitas" />
      <main className="user-page community-create-page">
        {/* `noValidate` for the reason every other form in this app carries it:
            the browser's own bubbles are English and unstyled, and the server is
            the authority on what is valid anyway. */}
        <form onSubmit={handleSubmit} className="stack" noValidate>
          <Field label="Nama komunitas" name="name">
            <input
              id="field-name"
              type="text"
              value={name}
              maxLength={MAX_COMMUNITY_NAME_LENGTH}
              onChange={(e) => setName(e.target.value.slice(0, MAX_COMMUNITY_NAME_LENGTH))}
            />
          </Field>

          <Field
            label="Kategori"
            name="category"
            hint="Kategori menentukan di mana komunitas Anda muncul di Jelajah."
          >
            {/*
              A `<select>` of exactly the six, generated from the shared tuple
              rather than typed out here — the API validates against that same
              tuple, so a hand-written seventh option would be a 400 nobody
              could have predicted from the form.
            */}
            <select
              id="field-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Pilih kategori</option>
              {COMMUNITY_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Deskripsi" name="description" hint="Opsional.">
            <textarea
              id="field-description"
              value={description}
              maxLength={MAX_COMMUNITY_DESCRIPTION_LENGTH}
              rows={3}
              onChange={(e) =>
                setDescription(e.target.value.slice(0, MAX_COMMUNITY_DESCRIPTION_LENGTH))
              }
            />
          </Field>

          <Field label="Tag" name="tags" hint="Pisahkan dengan koma. Opsional.">
            <input
              id="field-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </Field>

          <button type="submit" className="button-primary btn" disabled={submitting}>
            Buat komunitas
          </button>

          {message === null ? null : (
            <p className="form-error" role="alert">
              {message}
            </p>
          )}
        </form>
      </main>
    </>
  );
}

/** The same field wrapper `SignupPage` uses, kept local for the same reason it is there. */
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
