import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { signup, UserApiError } from "./apiClient";

/**
 * `POST /users/signup`'s 409 — a duplicate HANDLE, which is public by design
 * (see `RegisterUser`'s own docstring: anyone can browse `/@wildan`, so
 * saying one is taken leaks nothing browsing does not). A duplicate EMAIL
 * never reaches this branch at all — it answers `201 { ok: true }`, the
 * SAME shape as a fresh signup, and is handled below by simply treating
 * every successful call identically.
 */
const HANDLE_TAKEN_FALLBACK = "Handle ini sudah digunakan. Coba handle lain.";

/** The message `LoginPage` shows after a successful signup — Task 2: signup never logs the caller in. */
export const SIGNUP_SUCCESS_MESSAGE = "Akun dibuat. Silakan masuk.";

export default function SignupPage() {
  const navigate = useNavigate();
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function describe(err: unknown): { message: string; fieldErrors: Record<string, string> } {
    if (err instanceof UserApiError) {
      if (err.status === 409) return { message: HANDLE_TAKEN_FALLBACK, fieldErrors: {} };
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
      // A duplicate email resolves this SAME promise with `{ ok: true }` —
      // there is nothing here to branch on, by design. See
      // `signup`'s own docstring in apiClient.ts.
      await signup({
        handle: handle.trim(),
        email: email.trim(),
        password,
        displayName: displayName.trim(),
        whatsappNumber: whatsappNumber.trim() === "" ? undefined : whatsappNumber.trim(),
      });
      navigate("/masuk", { state: { message: SIGNUP_SUCCESS_MESSAGE } });
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
        <h1>Buat akun</h1>

        <form onSubmit={handleSubmit} className="stack" noValidate>
          <Field label="Handle" name="handle" error={fieldErrors.handle}>
            <input
              id="field-handle"
              type="text"
              autoComplete="username"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              aria-invalid={fieldErrors.handle !== undefined}
            />
          </Field>

          <Field label="Nama tampilan" name="displayName" error={fieldErrors.displayName}>
            <input
              id="field-displayName"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              aria-invalid={fieldErrors.displayName !== undefined}
            />
          </Field>

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
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldErrors.password !== undefined}
            />
          </Field>

          <Field
            label="Nomor WhatsApp (opsional)"
            name="whatsappNumber"
            error={fieldErrors.whatsappNumber}
            hint="Untuk memulihkan sandi dan memberi tahu Anda saat ada siaran langsung."
          >
            <input
              id="field-whatsappNumber"
              type="tel"
              autoComplete="tel"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              aria-invalid={fieldErrors.whatsappNumber !== undefined}
            />
          </Field>

          {message !== null ? (
            <p className="form-error" role="alert">
              {message}
            </p>
          ) : null}

          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Memproses..." : "Daftar"}
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
  hint,
  children,
}: {
  label: string;
  name: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      {children}
      {hint !== undefined ? <p className="hint">{hint}</p> : null}
      {error !== undefined ? (
        <p className="field-error" data-testid={`error-${name}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
