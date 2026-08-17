import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { completePasswordReset, UserApiError } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";

/**
 * `CompletePasswordReset`'s ONE message for a missing, expired, or
 * already-used token (Task 5) — a reset token is a bearer credential, and
 * telling those three cases apart would tell a caller holding a stale or
 * guessed token which of the three is true. Must not be narrowed here.
 */
const INVALID_TOKEN_MESSAGE = "Tautan ini sudah tidak berlaku. Silakan minta tautan baru.";

type Phase = "form" | "submitting" | "done";

export default function ResetCompletePage() {
  const { token } = useParams<{ token: string }>();
  const [newPassword, setNewPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!token) {
      setError(INVALID_TOKEN_MESSAGE);
      return;
    }
    setPhase("submitting");
    try {
      await completePasswordReset(token, newPassword);
      setPhase("done");
    } catch (err) {
      // A missing/expired/used token all answer with the same 401 — see the
      // constant above. Anything else (a 400 on the password's own rules, a
      // network failure) gets its own message instead of that one, since
      // those are not part of the enumeration-safety guarantee.
      if (err instanceof UserApiError && err.status === 401) {
        setError(INVALID_TOKEN_MESSAGE);
      } else {
        setError(describeRequestFailure(err));
      }
      setPhase("form");
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="brand">DIUDARA</p>
        <h1>Atur ulang sandi</h1>

        {phase === "done" ? (
          <>
            <p className="form-ok">Sandi berhasil diganti. Silakan masuk.</p>
            <p>
              <Link className="button-primary" to="/masuk">
                Ke halaman masuk
              </Link>
            </p>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="stack" noValidate>
            <div className="field">
              <label htmlFor="field-newPassword">Kata sandi baru</label>
              <input
                id="field-newPassword"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>

            {error !== null ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="button-primary" disabled={phase === "submitting"}>
              {phase === "submitting" ? "Memproses..." : "Ganti sandi"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
