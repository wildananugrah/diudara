import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import {
  clearUserToken,
  getOwnProfile,
  getUserToken,
  subscribeToUserAuth,
  updateOwnProfile,
  UserApiError,
  type OwnUserProfile,
} from "./apiClient";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; profile: OwnUserProfile };

/**
 * `/pengaturan` — requires a session. Mirrors `dashboard/RequireAuth.tsx`'s
 * own reasoning exactly, inlined here rather than split into a separate
 * file (only this one page needs it today): SUBSCRIBING to the token,
 * rather than reading it once, is what makes a token that expires WHILE
 * this page is open recoverable — `apiFetch`/`apiRequest` clear it on the
 * first 401, this re-renders, and the `Navigate` below fires from inside
 * the router instead of leaving the page stuck on a stale form.
 */
export default function SettingsPage() {
  const token = useSyncExternalStore(subscribeToUserAuth, getUserToken, () => null);
  const location = useLocation();

  if (token === null) {
    return (
      <Navigate
        to="/masuk"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <SettingsForm />;
}

function SettingsForm() {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    getOwnProfile()
      .then((profile) => {
        if (cancelled) return;
        setLoad({ status: "ready", profile });
        setDisplayName(profile.displayName);
        setBio(profile.bio ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: err instanceof Error ? err.message : "gagal memuat profil",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSaved(false);
    setSubmitting(true);
    try {
      const updated = await updateOwnProfile({ displayName, bio });
      setLoad({ status: "ready", profile: updated });
      setDisplayName(updated.displayName);
      setBio(updated.bio ?? "");
      setSaved(true);
    } catch (err) {
      if (err instanceof UserApiError && err.status === 400) {
        setMessage(Object.keys(err.fieldErrors).length > 0 ? "Periksa data yang Anda isi." : err.message);
        setFieldErrors(err.fieldErrors);
      } else if (err instanceof UserApiError) {
        setMessage(err.message);
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (load.status === "loading") {
    return (
      <main className="user-page">
        <p>Memuat...</p>
      </main>
    );
  }

  if (load.status === "error") {
    return (
      <main className="user-page">
        <h1>Gagal memuat profil</h1>
        <p>{load.message}</p>
      </main>
    );
  }

  const { profile } = load;

  return (
    <main className="user-page">
      <div className="spread">
        <h1>Pengaturan akun</h1>
        {/*
          F3 (review): this was the ONLY way in — there was no way out. A
          signed-in visitor is bounced away from /masuk (LoginPage.tsx), so
          without this button /pengaturan was the one place a signed-in user
          could reach and the one place they could never leave their session
          from. Mirrors dashboard/DashboardLayout.tsx's own "Keluar" exactly:
          clearUserToken() only clears and notifies — it does not navigate.
          SettingsPage's own guard above is already SUBSCRIBED to the token,
          so the resulting re-render (token now null) is what sends this
          page to /masuk, the same single code path an expired session takes.
        */}
        <button type="button" className="button-quiet" onClick={() => clearUserToken()}>
          Keluar
        </button>
      </div>

      <div className="card stack">
        <p className="muted">@{profile.handle}</p>
        <p className="muted">{profile.email}</p>
        {/*
          Minor (review): GET /users/me returns whatsappNumber, and the
          signup form's own hint tells the caller this number is what
          password recovery and live-stream notices use — so someone who
          mistyped it needs a way to at least SEE it, even with no PATCH
          field to fix it yet (updateProfileSchema has no whatsappNumber
          field at all — Task 3's actual schema, not an oversight here).
        */}
        <p className="muted">
          {profile.whatsappNumber !== null ? profile.whatsappNumber : "Nomor WhatsApp belum diatur"}
        </p>

        <form onSubmit={handleSubmit} className="stack" noValidate>
          <Field label="Nama tampilan" name="displayName" error={fieldErrors.displayName}>
            <input
              id="field-displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-invalid={fieldErrors.displayName !== undefined}
            />
          </Field>

          <Field label="Bio" name="bio" error={fieldErrors.bio}>
            <textarea
              id="field-bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              aria-invalid={fieldErrors.bio !== undefined}
            />
          </Field>

          {message !== null ? (
            <p className="form-error" role="alert">
              {message}
            </p>
          ) : null}

          {saved && message === null ? <p className="form-ok">Perubahan disimpan.</p> : null}

          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Simpan perubahan"}
          </button>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  name,
  error,
  children,
}: {
  label: string;
  name: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      {children}
      {error !== undefined ? (
        <p className="field-error" data-testid={`error-${name}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
