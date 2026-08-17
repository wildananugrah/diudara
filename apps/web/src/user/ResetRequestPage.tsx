import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { requestPasswordReset } from "./apiClient";

/**
 * `POST /users/password-reset/request`'s copy — and this exact wording is
 * LOAD-BEARING, not filler. `RequestPasswordReset` (Task 5) answers `200
 * { ok: true }` whether or not the email has an account, whether the
 * account is over its rate limit, and whether it has any channel to send
 * over at all — measured down to a 1.75ms timing difference between the
 * "found" and "not found" paths. This sentence is the one place that
 * guarantee has to stay true in the UI too: it must read as correct
 * regardless of which of those cases actually happened, so it NEVER says
 * anything that would let a visitor infer which one they hit — no "we
 * found your account", no "check your email", no different wording for a
 * failed send. One sentence, shown for every successful submission.
 */
const RESET_REQUESTED_MESSAGE = "Kami akan mengirim tautan pemulihan jika akun dengan data tersebut ada.";

type Phase = "form" | "submitting" | "requested";

export default function ResetRequestPage() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPhase("submitting");
    try {
      // The email itself never determines what is shown next — see the
      // constant's own docstring. Every 200 renders the same phase.
      await requestPasswordReset(email);
      setPhase("requested");
    } catch {
      // A network failure or a 5xx is not itself a leak — it says nothing
      // about whether the account exists, only that the request could not
      // be completed at all — so a distinct message here is safe.
      setError("Permintaan gagal dikirim. Coba lagi.");
      setPhase("form");
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">DIUDARA</p>
        <h1>Lupa sandi</h1>

        {phase === "requested" ? (
          <p className="form-ok">{RESET_REQUESTED_MESSAGE}</p>
        ) : (
          <form onSubmit={handleSubmit} className="stack" noValidate>
            <div className="field">
              <label htmlFor="field-email">Email</label>
              <input
                id="field-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {error !== null ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="button-primary" disabled={phase === "submitting"}>
              {phase === "submitting" ? "Mengirim..." : "Kirim tautan pemulihan"}
            </button>
          </form>
        )}

        <p>
          <Link className="button-link" to="/masuk">
            Kembali ke halaman masuk
          </Link>
        </p>
      </div>
    </main>
  );
}
