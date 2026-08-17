import { useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { getUserToken, login, UserApiError } from "./apiClient";

/**
 * THE GENERIC 401, and the reason it is a constant rather than the API's
 * words. `AuthenticateUser` returns the SAME error for an unknown email and
 * a wrong password (Task 2) — a stranger must not be able to use this form
 * to learn which emails have accounts. The UI must not undo that: a 401
 * always renders this one sentence, never anything that distinguishes the
 * two cases.
 */
const GENERIC_CREDENTIALS_MESSAGE = "Email atau kata sandi salah.";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Already signed in: nothing here to do.
  if (getUserToken() !== null) {
    return <Navigate to="/" replace />;
  }

  // Carried by SignupPage after a successful signup ("Akun dibuat. Silakan
  // masuk.") — Task 2: signup never logs the caller in, on purpose. Also the
  // path RequireAuth-style guards (SettingsPage) send a visitor back to,
  // once they are signed in.
  const state = (location.state as { message?: unknown; from?: unknown } | null) ?? null;
  const noticeFromState = typeof state?.message === "string" ? state.message : null;
  const destination = typeof state?.from === "string" ? state.from : "/";

  function describe(err: unknown): { message: string; fieldErrors: Record<string, string> } {
    if (err instanceof UserApiError) {
      if (err.status === 401) return { message: GENERIC_CREDENTIALS_MESSAGE, fieldErrors: {} };
      if (err.status === 400) {
        return {
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
      const result = await login({ email, password });
      navigate(destination === "/" ? `/@${result.user.handle}` : destination, { replace: true });
    } catch (err) {
      const described = describe(err);
      setMessage(described.message);
      setFieldErrors(described.fieldErrors);
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">DIUDARA</p>
        <h1>Masuk</h1>

        {noticeFromState !== null ? <p className="form-ok">{noticeFromState}</p> : null}

        <form onSubmit={handleSubmit} className="stack" noValidate>
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
              autoComplete="current-password"
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
            {submitting ? "Memproses..." : "Masuk"}
          </button>
        </form>

        <p>
          <Link className="button-link" to="/lupa-sandi">
            Lupa sandi?
          </Link>
        </p>
        <p>
          <Link className="button-link" to="/signup">
            Belum punya akun? Buat akun baru
          </Link>
        </p>
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
