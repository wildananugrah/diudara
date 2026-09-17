import { useState, type FormEvent, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleInfo, faEnvelope, faKey, faUserPen } from "@fortawesome/free-solid-svg-icons";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";
import Avatar from "../components/ui/Avatar";

/**
 * Mirrors the server's whitelist in AuthService. The server is the authority —
 * a colour it does not recognise is refused — so this list only decides what the
 * page OFFERS, never what is allowed.
 */
const AVATAR_COLORS = ["#93A8C2", "#2b4c6f", "#e8873e", "#4c8b6e", "#c1543d", "#3e6690"];

/** Same derivation the server applies on save, shown live so the avatar is no surprise. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + last).toUpperCase();
}

const message = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/**
 * One card per thing that can be saved.
 *
 * Deliberately not a single page-wide save button: these three calls fail for
 * different reasons — a taken handle, a wrong password, an email already
 * registered — and one shared error line would report the wrong cause.
 */
function Card({ icon, title, subtitle, children, onSubmit, busy, error, done, cta }: {
  icon: typeof faUserPen;
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  onSubmit: () => Promise<void>;
  busy: boolean;
  error: string | null;
  done: string | null;
  cta: string;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit();
  };

  return (
    <form className="card" onSubmit={submit} style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 15.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 9 }}>
          <FontAwesomeIcon icon={icon} style={{ color: "var(--sinyal)" }} /> {title}
        </h2>
        <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 4, lineHeight: 1.6 }}>{subtitle}</p>
      </div>

      {children}

      {error && <p style={{ fontSize: 13, color: "var(--merah-senja)", lineHeight: 1.5 }}>{error}</p>}
      {done && <p style={{ fontSize: 13, color: "var(--hijau-lepas)", lineHeight: 1.5 }}>{done}</p>}

      <div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Menyimpan…" : cta}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, ...input }: {
  label: string;
  hint?: string;
  value: string;
  type?: string;
  autoComplete?: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  const { onChange, ...rest } = input;
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-500)", display: "block", marginBottom: 5 }}>
        {label}
      </span>
      <input className="input" {...rest} onChange={(e) => onChange(e.target.value)} style={{ width: "100%" }} />
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--ink-500)", display: "block", marginTop: 5, lineHeight: 1.5 }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export default function Profile() {
  const { user, applyUser } = useAuth();

  // Identity card
  const [name, setName] = useState(user?.name ?? "");
  const [handle, setHandle] = useState(user?.handle ?? "");
  const [color, setColor] = useState(user?.avatarColor ?? AVATAR_COLORS[0]!);
  const [idBusy, setIdBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);
  const [idDone, setIdDone] = useState<string | null>(null);

  // Email card
  const [email, setEmail] = useState(user?.email ?? "");
  const [emailPassword, setEmailPassword] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailDone, setEmailDone] = useState<string | null>(null);

  // Password card
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState<string | null>(null);

  const saveIdentity = async () => {
    setIdError(null);
    setIdDone(null);
    setIdBusy(true);
    try {
      applyUser(await api.auth.updateProfile({ name, handle, avatarColor: color }));
      setIdDone("Profil tersimpan.");
    } catch (err) {
      setIdError(message(err, "Gagal menyimpan profil"));
    } finally {
      setIdBusy(false);
    }
  };

  const saveEmail = async () => {
    setEmailError(null);
    setEmailDone(null);
    setEmailBusy(true);
    try {
      applyUser(await api.auth.changeEmail({ currentPassword: emailPassword, email }));
      setEmailPassword("");
      setEmailDone("Email tersimpan. Pakai email baru ini saat masuk berikutnya.");
    } catch (err) {
      setEmailError(message(err, "Gagal mengubah email"));
    } finally {
      setEmailBusy(false);
    }
  };

  const savePassword = async () => {
    setPwError(null);
    setPwDone(null);
    // Checked here only to spare a round trip; everything that matters — the
    // current password and the minimum length — is decided by the server.
    if (newPassword !== confirmPassword) {
      setPwError("Konfirmasi kata sandi tidak sama.");
      return;
    }
    setPwBusy(true);
    try {
      await api.auth.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwDone("Kata sandi tersimpan.");
    } catch (err) {
      setPwError(message(err, "Gagal mengubah kata sandi"));
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <>
      <Header title="Profil Saya" breadcrumb={[{ label: "Profil Saya" }]} />
      <PageContainer>
        <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16, paddingBottom: 60 }}>
          <Card
            icon={faUserPen}
            title="Profil"
            subtitle="Nama dan handle yang dilihat anggota komunitas lain."
            onSubmit={saveIdentity}
            busy={idBusy}
            error={idError}
            done={idDone}
            cta="Simpan profil"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <Avatar initials={initialsOf(name)} color={color} size={56} />
              <div style={{ fontSize: 12.5, color: "var(--ink-500)", lineHeight: 1.6 }}>
                Inisial mengikuti nama secara otomatis — tidak perlu diatur sendiri.
              </div>
            </div>

            <Field label="Nama" value={name} maxLength={60} autoComplete="name" onChange={setName} />
            <Field
              label="Handle"
              value={handle}
              autoComplete="username"
              hint="Huruf kecil, angka dan _ saja, 3–20 karakter. Boleh ditulis dengan atau tanpa @."
              onChange={setHandle}
            />

            <div>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-500)", display: "block", marginBottom: 7 }}>
                Warna avatar
              </span>
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                {AVATAR_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Pilih warna ${c}`}
                    aria-pressed={c === color}
                    onClick={() => setColor(c)}
                    style={{
                      width: 34, height: 34, borderRadius: "50%", background: c, cursor: "pointer",
                      border: c === color ? "3px solid var(--ink-700)" : "3px solid transparent",
                      outline: c === color ? "none" : "1px solid var(--ink-100)",
                    }}
                  />
                ))}
              </div>
            </div>
          </Card>

          <Card
            icon={faEnvelope}
            title="Email"
            subtitle="Dipakai untuk masuk. Mengubahnya butuh kata sandi saat ini."
            onSubmit={saveEmail}
            busy={emailBusy}
            error={emailError}
            done={emailDone}
            cta="Simpan email"
          >
            <Field label="Email" value={email} type="email" autoComplete="email" onChange={setEmail} />
            <Field
              label="Kata sandi saat ini"
              value={emailPassword}
              type="password"
              autoComplete="current-password"
              onChange={setEmailPassword}
            />
            {/* SPEC.md §6 — there is no mailer in this project, so saying "cek
                inbox kamu" would describe a step that does not exist. */}
            <p style={{ fontSize: 11.5, color: "var(--ink-500)", lineHeight: 1.6, display: "flex", gap: 8 }}>
              <FontAwesomeIcon icon={faCircleInfo} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>
                Email baru langsung berlaku tanpa email konfirmasi — aplikasi ini belum mengirim
                email sama sekali. Pastikan alamatnya benar sebelum menyimpan.
              </span>
            </p>
          </Card>

          <Card
            icon={faKey}
            title="Kata sandi"
            subtitle="Minimal 8 karakter."
            onSubmit={savePassword}
            busy={pwBusy}
            error={pwError}
            done={pwDone}
            cta="Simpan kata sandi"
          >
            <Field
              label="Kata sandi saat ini"
              value={currentPassword}
              type="password"
              autoComplete="current-password"
              onChange={setCurrentPassword}
            />
            <Field
              label="Kata sandi baru"
              value={newPassword}
              type="password"
              autoComplete="new-password"
              onChange={setNewPassword}
            />
            <Field
              label="Ulangi kata sandi baru"
              value={confirmPassword}
              type="password"
              autoComplete="new-password"
              onChange={setConfirmPassword}
            />
            <p style={{ fontSize: 11.5, color: "var(--ink-500)", lineHeight: 1.6, display: "flex", gap: 8 }}>
              <FontAwesomeIcon icon={faCircleInfo} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>
                Perangkat lain yang sudah masuk tidak ikut keluar setelah kata sandi diganti.
                Kalau kamu curiga ada yang memakai akunmu, keluar dari perangkat itu langsung.
              </span>
            </p>
          </Card>
        </div>
      </PageContainer>
    </>
  );
}
