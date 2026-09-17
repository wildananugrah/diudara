import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faEye,
  faTowerBroadcast,
} from "@fortawesome/free-solid-svg-icons";
import { api, type ApiLiveChat } from "../lib/api";
import { useApi } from "../lib/useApi";
import { clockTime, formatCount } from "../lib/format";
import { FullPageMessage } from "../lib/auth";

const CHAT_POLL_MS = 5_000;
/**
 * Comfortably inside the server's presence window (45s), so one dropped request
 * does not drop the viewer out of the count.
 */
const PRESENCE_PING_MS = 20_000;
/** The room's own state, so a stream that starts or ends is noticed without a reload. */
const LIVE_POLL_MS = 15_000;

/**
 * Attaches the community's live stream to a <video>.
 *
 * Two playback paths, because browsers disagree: Safari plays HLS natively, and
 * everything else needs Media Source Extensions driven by hls.js. hls.js is
 * imported lazily so the ~110 kB only loads for someone actually watching, never
 * for the rest of the app.
 *
 * The url comes from the server and carries a watch token, which MediaMTX hands
 * back to /webhooks/mediamtx/auth to decide whether this viewer may read the
 * stream at all. Nothing here proves membership on its own.
 */
function useHlsPlayback(communityId: string, isLive: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLive || !communityId) return;

    let cancelled = false;
    let destroy: (() => void) | undefined;

    (async () => {
      try {
        const { playbackUrl } = await api.live.watchToken(communityId);
        const video = videoRef.current;
        if (cancelled || !video) return;

        // Safari: the browser does the whole job, including the cookie MediaMTX
        // sets to remember this playback session.
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = playbackUrl;
          setReady(true);
          return;
        }

        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        if (!Hls.isSupported()) {
          setError("Browser ini tidak mendukung pemutaran HLS.");
          return;
        }

        const hls = new Hls({ lowLatencyMode: true });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          // Non-fatal errors are hls.js's normal recovery chatter; only a fatal
          // one means this viewer is genuinely not watching anything.
          if (data.fatal) setError("Siaran tidak bisa dimuat. Coba muat ulang halaman.");
        });
        hls.loadSource(playbackUrl);
        hls.attachMedia(video);
        setReady(true);
        destroy = () => hls.destroy();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Gagal meminta izin menonton");
      }
    })();

    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [communityId, isLive]);

  return { videoRef, error, ready };
}

export default function LiveRoomPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const communityId = id ?? "";

  const community = useApi(() => api.communities.detail(communityId), [communityId]);
  const live = useApi(() => api.live.state(communityId), [communityId]);

  const [chat, setChat] = useState<ApiLiveChat[]>([]);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState("");
  const chatRef = useRef<HTMLDivElement | null>(null);

  const isLive = live.data?.status === "live";
  const playback = useHlsPlayback(communityId, isLive);

  const refreshChat = useCallback(async () => {
    if (!communityId) return;
    try {
      setChat(await api.live.chat(communityId));
    } catch {
      // Transient poll failures are not worth surfacing; the next tick retries.
    }
  }, [communityId]);

  useEffect(() => {
    if (!isLive) return;
    void refreshChat();
    const timer = setInterval(() => void refreshChat(), CHAT_POLL_MS);
    return () => clearInterval(timer);
  }, [isLive, refreshChat]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  // Being here, with something on air, is what "watching" means — the viewer
  // count on this page and on the Discover cards is the number of members whose
  // player said this recently. Nothing else feeds it.
  useEffect(() => {
    if (!isLive || !communityId) return;
    const ping = () => { void api.live.heartbeat(communityId).catch(() => {}); };
    ping();
    const timer = setInterval(ping, PRESENCE_PING_MS);
    return () => clearInterval(timer);
  }, [isLive, communityId]);

  // The count only moves if we ask again, and so does "the host just went live".
  useEffect(() => {
    const timer = setInterval(() => live.reload(), LIVE_POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communityId]);

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    setSendError("");
    try {
      await api.live.sendChat(communityId, body);
      await refreshChat();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Komentar gagal dikirim");
      setDraft(body);
    }
  };

  // Only the FIRST load blanks the page. `useApi.reload()` sets loading again, so
  // gating on it alone made the 15s poll unmount the <video> mid-stream — the
  // player restarted from nothing every fifteen seconds.
  if ((community.loading && !community.data) || (live.loading && !live.data)) {
    return <FullPageMessage text="Memuat ruang live…" />;
  }
  if (community.error) return <FullPageMessage text={community.error} tone="error" />;
  if (!community.data) return <FullPageMessage text="Komunitas tidak ditemukan" tone="error" />;

  const c = community.data;
  const title = live.data?.title ?? `${c.name} — Sesi Live`;

  return (
    <div style={{ minHeight: "100vh", background: "var(--ink-900)", color: "#fff", display: "flex", flexDirection: "column" }}>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => navigate(`/community/${c.id}`)}
            className="btn btn-ghost btn-sm"
            style={{ color: "#fff", border: "1px solid rgba(255,255,255,0.2)" }}
          >
            <FontAwesomeIcon icon={faArrowLeft} /> Keluar
          </button>
          {isLive
            ? <span className="live-badge"><span className="dot"></span>LIVE</span>
            : <span className="badge badge-neutral">Tidak sedang live</span>}
          <span style={{ fontSize: 14, fontWeight: 600 }}>{title}</span>
        </div>
        <span style={{ fontSize: 13, color: "#9CACC0" }}>
          <FontAwesomeIcon icon={faEye} /> {formatCount(live.data?.viewerCount ?? 0)} menonton
        </span>
      </div>

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 320px", minHeight: 0 }}>
        {/* Area video */}
        <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
          <div
            style={{
              flex: 1, borderRadius: 16, overflow: "hidden",
              background: isLive && !playback.error
                ? "#000"
                : "linear-gradient(135deg, var(--langit), var(--langit-dark))",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              gap: 14, padding: isLive && !playback.error ? 0 : 32, textAlign: "center",
            }}
          >
            {isLive && !playback.error ? (
              // muted+autoPlay because a browser refuses to start audible playback
              // without a gesture; the controls let the viewer unmute.
              <video
                ref={playback.videoRef}
                autoPlay
                muted
                playsInline
                controls
                style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
              />
            ) : (
              <>
                <FontAwesomeIcon icon={faTowerBroadcast} style={{ fontSize: 40, opacity: 0.85 }} />
                <p style={{ fontSize: 16, fontWeight: 600 }}>
                  {isLive ? "Siaran tidak bisa diputar" : "Belum ada sesi live"}
                </p>
                <p style={{ fontSize: 13, color: "#C6D2DE", maxWidth: 440, lineHeight: 1.6 }}>
                  {playback.error ??
                    "Pemutar akan otomatis aktif begitu host mulai menyiarkan. Live chat di sebelah kanan sudah berfungsi sekarang."}
                </p>
                {/*
                  Still not a fake video surface. When a session IS live this area
                  plays the real HLS stream; when it is not, it says so rather than
                  rendering a placeholder that looks like a stream.
                */}
              </>
            )}
          </div>

          {/*
            The mic/camera/hang-up row that used to sit here is gone. It was three
            buttons for a multi-party call this app does not have: two permanently
            disabled, and a red "leave" button duplicating "Keluar" in the top bar.
            Controls that cannot do anything are not honest affordances.
          */}
        </div>

        {/* Panel chat */}
        <div style={{ borderLeft: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.08)", fontSize: 13.5, fontWeight: 600 }}>
            Live Chat
          </div>
          <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            {!isLive && (
              <p style={{ fontSize: 12.5, color: "#9CACC0" }}>
                Live chat aktif saat sesi sedang berlangsung.
              </p>
            )}
            {isLive && chat.length === 0 && (
              <p style={{ fontSize: 12.5, color: "#9CACC0" }}>Belum ada komentar. Jadi yang pertama!</p>
            )}
            {chat.map((m) => (
              <div key={m.id} style={{ fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: "var(--sinyal-light)" }}>{m.userName}: </span>
                <span style={{ color: "#D9E2EA" }}>{m.body}</span>
                <span style={{ marginLeft: 6, fontSize: 10.5, color: "#6F8098" }}>{clockTime(m.createdAt)}</span>
              </div>
            ))}
          </div>
          {sendError && (
            <p style={{ padding: "0 14px 6px", fontSize: 11.5, color: "var(--merah-senja)" }}>{sendError}</p>
          )}
          <div style={{ padding: 14, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder={isLive ? "Tulis komentar..." : "Sesi belum dimulai"}
              disabled={!isLive}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)", color: "#fff" }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => void send()} disabled={!isLive}>Kirim</button>
          </div>
        </div>
      </div>
    </div>
  );
}
