import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { DashboardApiError, login, signup } from "./apiClient";
import { getToken } from "./auth";

/**
 * THE GENERIC 401, and the reason it is a constant rather than the API's words.
 *
 * `AuthenticateCreator` returns the SAME error for an unknown email, a wrong
 * password, and an account with no password set — deliberately, so a stranger
 * cannot use the login form to find out which email addresses have accounts. The
 * UI must not undo that. So a 401 renders this one sentence and never "no such
 * account", never "wrong password for that email", and never anything that
 * distinguishes the two.
 */
const GENERIC_CREDENTIALS_MESSAGE = "Email atau kata sandi salah.";

/** `POST /auth/signup`'s 409, in Indonesian. */
const EMAIL_TAKEN_MESSAGE = "Email ini sudah terdaftar. Silakan masuk dengan kata sandi Anda.";

type Mode = "login" | "signup";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Already signed in: nothing here to do. `replace` so the back button does not
  // bounce between the two.
  if (getToken() !== null) {
    return <Navigate to="/dashboard" replace />;
  }

  // Where RequireAuth was sending them before it found no token. A path only —
  // the token is never in a URL, so there is nothing sensitive to carry here.
  const from = (location.state as { from?: unknown } | null)?.from;
  const destination = typeof from === "string" && from.startsWith("/dashboard") ? from : "/dashboard";

  function describe(err: unknown): { message: string; fieldErrors: Record<string, string> } {
    if (err instanceof DashboardApiError) {
      if (err.status === 401) return { message: GENERIC_CREDENTIALS_MESSAGE, fieldErrors: {} };
      if (err.status === 409) return { message: EMAIL_TAKEN_MESSAGE, fieldErrors: {} };
      if (err.status === 400) {
        return {
          // Both, always: a field message the parser did not recognise would
          // otherwise vanish. See `parseFieldErrors`.
          message: Object.keys(err.fieldErrors).length > 0 ? "Periksa data yang Anda isi." : err.message,
          fieldErrors: err.fieldErrors,
        };
      }
      return { message: err.message, fieldErrors: {} };
    }
    return { message: "Tidak dapat menghubungi server. Coba lagi.", fieldErrors: {} };
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      if (mode === "signup") {
        await signup({ name, email, password });
      } else {
        await login({ email, password });
      }
      navigate(destination, { replace: true });
    } catch (err) {
      // Nothing is reset on failure: the creator keeps what they typed and only
      // has to fix the part that was wrong.
      const described = describe(err);
      setMessage(described.message);
      setFieldErrors(described.fieldErrors);
      setSubmitting(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setMessage(null);
    setFieldErrors({});
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">DIUDARA</p>
        <h1>{mode === "login" ? "Masuk ke DIUDARA" : "Daftar sebagai kreator"}</h1>
        <p className="muted">
          {mode === "login"
            ? "Kelola komunitas, paket, dan anggota Anda."
            : "Buat akun untuk mulai menjual keanggotaan komunitas Anda."}
        </p>

        <form onSubmit={handleSubmit} className="stack" noValidate>
          {mode === "signup" ? (
            <Field label="Nama" name="name" error={fieldErrors.name}>
              <input
                id="field-name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={fieldErrors.name !== undefined}
              />
            </Field>
          ) : null}

          <Field label="Email" name="email" error={fieldErrors.email}>
            <input
              id="field-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={fieldErrors.email !== undefined}
            />
          </Field>

          <Field label="Kata sandi" name="password" error={fieldErrors.password}>
            <input
              id="field-password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldErrors.password !== undefined}
            />
          </Field>

          {message !== null ? (
            <p className="form-error" role="alert">
              {message}
            </p>
          ) : null}

          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Memproses..." : mode === "login" ? "Masuk" : "Daftar"}
          </button>
        </form>

        {mode === "login" ? (
          <button type="button" className="button-link" onClick={() => switchMode("signup")}>
            Belum punya akun? Daftar akun baru
          </button>
        ) : (
          <button type="button" className="button-link" onClick={() => switchMode("login")}>
            Sudah punya akun? Kembali ke halaman masuk
          </button>
        )}
      </div>
    </main>
  );
}

/**
 * A label, its input, and the field's own error message.
 *
 * The error is keyed by the API's field NAME (`password`), not the Indonesian
 * label (`Kata sandi`) — that is what `parseFieldErrors` produces, and translating
 * the API's own validation prose is a separate job nobody has done yet.
 */
function Field({
  label,
  name,
  error,
  children,
}: {
  label: string;
  name: string;
  error: string | undefined;
  children: React.ReactNode;
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
