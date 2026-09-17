import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faUser, faEnvelope, faLock, faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import logoDark from "../assets/logo-dark.svg";
import { useAuth } from "../lib/auth";

export default function Register() {
  const navigate = useNavigate();
  const { register, user, loading } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) return <Navigate to="/discover" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name || !email || !password || !confirmPassword) {
      setError("Semua kolom wajib diisi.");
      return;
    }
    if (password.length < 8) {
      setError("Kata sandi minimal 8 karakter.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Konfirmasi kata sandi tidak cocok.");
      return;
    }
    if (!agree) {
      setError("Kamu harus menyetujui syarat & ketentuan.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await register(name, email, password);
      navigate("/discover", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mendaftar");
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

        <h1 style={{ fontSize: 22, textAlign: "center", marginBottom: 6 }}>Buat akun baru</h1>
        <p style={{ fontSize: 14, color: "var(--ink-500)", textAlign: "center", marginBottom: 28 }}>
          Gabung dan mulai jelajahi komunitas di DIUDARA
        </p>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-700)" }}>
            Nama lengkap
            <div style={{ position: "relative", marginTop: 6 }}>
              <FontAwesomeIcon
                icon={faUser}
                style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: "var(--ink-300)", fontSize: 13 }}
              />
              <input
                type="text"
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="Nama kamu"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </label>

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

          <label style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-700)" }}>
            Konfirmasi kata sandi
            <div style={{ position: "relative", marginTop: 6 }}>
              <FontAwesomeIcon
                icon={faLock}
                style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: "var(--ink-300)", fontSize: 13 }}
              />
              <input
                type={showPassword ? "text" : "password"}
                className="input"
                style={{ paddingLeft: 36 }}
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "var(--ink-700)" }}>
            <input
              type="checkbox"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              Saya setuju dengan{" "}
              <Link to="/terms" style={{ fontWeight: 700, color: "var(--langit)" }}>
                Syarat & Ketentuan
              </Link>{" "}
              DIUDARA
            </span>
          </label>

          {error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{error}</p>}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? "Memproses…" : "Daftar"}
          </button>
        </form>

        <p style={{ fontSize: 13, color: "var(--ink-500)", textAlign: "center", marginTop: 24 }}>
          Sudah punya akun?{" "}
          <Link to="/login" style={{ fontWeight: 700, color: "var(--langit)" }}>
            Masuk
          </Link>
        </p>
      </div>
    </div>
  );
}
