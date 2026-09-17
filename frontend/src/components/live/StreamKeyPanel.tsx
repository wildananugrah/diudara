import { useCallback, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck, faCopy, faEye, faEyeSlash, faKey, faRotate, faTowerBroadcast,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * The creator's broadcast credentials, for OBS.
 *
 * Mounted only when the admin asks for it, because fetching the key is what
 * PROVISIONS the community's live room server-side — an admin who never intends
 * to stream should not leave a session row behind just by opening an event.
 *
 * The key is a credential, not a label: :1935 is open to the internet, so anyone
 * holding this string can broadcast into the community. It renders masked, and
 * rotation is the only way to revoke one that leaked.
 */
export default function StreamKeyPanel({ communityId }: { communityId: string }) {
  const credsQ = useApi(useCallback(() => api.live.streamKey(communityId), [communityId]));

  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const creds = credsQ.data;

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // The field is selectable, so say so rather than failing silently.
      setError("Tidak bisa menyalin otomatis — pilih teksnya lalu salin manual.");
    }
  };

  const rotate = async () => {
    setError(null);
    setRotating(true);
    try {
      const next = await api.live.rotateStreamKey(communityId);
      setConfirmingRotate(false);
      setRevealed(true);
      setNotice(
        next.endedActiveSession
          ? "Kunci diganti. Sesi yang sedang berjalan ditandai selesai — siaran lama masih mengalir sampai OBS-nya berhenti, tapi tidak bisa connect lagi."
          : "Kunci diganti. Perbarui Stream Key di OBS sebelum siaran berikutnya.",
      );
      credsQ.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengganti kunci");
    } finally {
      setRotating(false);
    }
  };

  const field = (label: string, value: string, secret = false) => (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-500)", display: "block", marginBottom: 5 }}>
        {label}
      </label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="input"
          readOnly
          value={secret && !revealed ? "•".repeat(Math.min(value.length, 22)) : value}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5 }}
        />
        {secret && (
          <button
            className="btn btn-ghost btn-sm"
            aria-label={revealed ? `Sembunyikan ${label}` : `Tampilkan ${label}`}
            title={revealed ? "Sembunyikan" : "Tampilkan"}
            onClick={() => setRevealed((r) => !r)}
            style={{ flexShrink: 0 }}
          >
            <FontAwesomeIcon icon={revealed ? faEyeSlash : faEye} />
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm"
          aria-label={`Salin ${label}`}
          title="Salin"
          onClick={() => copy(label, value)}
          style={{ flexShrink: 0, color: copied === label ? "var(--hijau-lepas)" : undefined }}
        >
          <FontAwesomeIcon icon={copied === label ? faCheck : faCopy} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <p style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          <FontAwesomeIcon icon={faTowerBroadcast} style={{ color: "var(--sinyal)" }} />
          Kredensial siaran
        </p>
        <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 3, lineHeight: 1.6 }}>
          Buka OBS → Settings → Stream → Service “Custom”, lalu tempelkan dua kolom di bawah
          apa adanya. Hanya admin komunitas yang bisa melihat ini.
        </p>
      </div>

      {credsQ.loading && <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Menyiapkan ruang siaran…</p>}
      {credsQ.error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{credsQ.error}</p>}

      {creds && (
        <>
          {field("Server", creds.serverUrl)}
          {/* The OBS-ready value: the public path key with the broadcast
              credential attached as a query. Masked because of that second half —
              the key alone is harmless (every viewer's playback url carries it),
              the credential is not. */}
          {field("Stream Key", creds.obsStreamKey, true)}

          {notice && (
            <p style={{ fontSize: 12.5, color: "var(--ink-700)", background: "var(--awan)", padding: "10px 12px", borderRadius: 10, lineHeight: 1.6 }}>
              {notice}
            </p>
          )}
          {error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{error}</p>}

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <p style={{ fontSize: 12.5, color: "var(--ink-500)", display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  width: 8, height: 8, borderRadius: "50%", display: "inline-block",
                  background: creds.status === "live" ? "var(--merah-senja)" : "var(--ink-300)",
                }}
              />
              {creds.status === "live" ? "Sedang mengudara" : "Belum mengudara"}
            </p>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingRotate(true)} style={{ flexShrink: 0 }}>
              <FontAwesomeIcon icon={faRotate} /> Ganti kunci
            </button>
          </div>

          <p style={{ fontSize: 12, color: "var(--ink-500)", lineHeight: 1.6, display: "flex", gap: 8 }}>
            <FontAwesomeIcon icon={faTriangleExclamation} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>
              Stream Key di atas memuat kata sandi siaran — jangan dibagikan atau ikut tersorot
              saat share screen. Kalau sempat bocor, tekan “Ganti kunci”. Anggota otomatis bisa
              menonton dari Live Room begitu kamu mulai menyiarkan.
            </span>
          </p>
        </>
      )}

      {confirmingRotate && (
        <ConfirmDialog
          title="Ganti kunci siaran?"
          subtitle="Kunci lama langsung tidak berlaku"
          confirmLabel="Ya, ganti kunci"
          busyLabel="Mengganti…"
          busy={rotating}
          onCancel={() => setConfirmingRotate(false)}
          onConfirm={rotate}
        >
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
            <FontAwesomeIcon icon={faKey} /> OBS yang masih memakai kunci lama tidak akan bisa
            connect lagi, dan kalau ada sesi yang sedang mengudara, sesi itu ditandai selesai.
            Perbarui Stream Key di OBS setelah ini.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
