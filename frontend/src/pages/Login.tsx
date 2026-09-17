import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope, faLock, faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import logoDark from "../assets/logo-dark.svg";
import { useAuth } from "../lib/auth";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, user, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Returns the user where they were headed before the redirect to /login.
  const from = (location.state as { from?: string } | null)?.from ?? "/discover";
  if (!loading && user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Email dan kata sandi wajib diisi.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal masuk");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "var(--awan)" }}>
      <div className="card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 24 }}>
          <img src={logoDark} alt="Diudara" style={{ height: 40, width: "auto" }} />
        </div>

        <h1 style={{ fontSize: 22, textAlign: "center", marginBottom: 6 }}>Masuk ke akunmu</h1>
        <p style={{ fontSize: 14, color: "var(--ink-500)", textAlign: "center", marginBottom: 28 }}>
          Lanjutkan untuk mengakses komunitasmu di DIUDARA
        </p>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-700)" }}>
            Email
            <div style={{ position: "relative", marginTop: 6 }}>
              <FontAwesomeIcon
                icon={faEnvelope}
                style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: "var(--ink-300)", fontSize: 13 }}
              />
              <input
                type="email"
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="nama@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </label>

          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-700)" }}>
            Kata sandi
            <div style={{ position: "relative", marginTop: 6 }}>
              <FontAwesomeIcon
                icon={faLock}
                style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: "var(--ink-300)", fontSize: 13 }}
              />
              <input
                type={showPassword ? "text" : "password"}
                className="input"
                style={{ paddingLeft: 36, paddingRight: 36 }}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                style={{ position: "absolute", right: 13, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--ink-300)", fontSize: 13 }}
              >
                <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} />
              </button>
            </div>
          </label>

          <div style={{ textAlign: "right" }}>
            <Link to="/forgot-password" style={{ fontSize: 13, fontWeight: 600, color: "var(--langit)" }}>
              Lupa kata sandi?
            </Link>
          </div>

          {error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{error}</p>}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Memproses…" : "Masuk"}
          </button>
        </form>

        <p style={{ fontSize: 13, color: "var(--ink-500)", textAlign: "center", marginTop: 24 }}>
          Belum punya akun?{" "}
          <Link to="/register" style={{ fontWeight: 700, color: "var(--langit)" }}>
            Daftar sekarang
          </Link>
        </p>
      </div>
    </div>
  );
}
