import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, fetchSubscriptionStatus } from "../api";

/** How often to re-check the subscription's status. */
const DEFAULT_POLL_INTERVAL_MS = 3000;

/**
 * How long to keep polling before giving up. An unpaid invoice never
 * activates on its own — Xendit's own invoices normally expire in 24h, but
 * this tab could sit open far longer than that — so polling forever would
 * hammer the API from every abandoned checkout tab. 5 minutes is generous
 * for a payment that is actually going through (bank transfer confirmation
 * can lag a little) while still bounded.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

type Phase =
  | { name: "checking" }
  | { name: "active" }
  | { name: "timed-out" }
  | { name: "not-found" }
  | { name: "error"; message: string };

export default function StatusPage({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  pollIntervalMs?: number;
  timeoutMs?: number;
} = {}) {
  const { subscriptionId } = useParams<{ subscriptionId: string }>();
  const [phase, setPhase] = useState<Phase>({ name: "checking" });

  useEffect(() => {
    if (!subscriptionId) {
      setPhase({ name: "not-found" });
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const deadline = Date.now() + timeoutMs;

    function stop() {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    }

    async function poll() {
      try {
        const result = await fetchSubscriptionStatus(subscriptionId!);
        if (cancelled) return;

        if (result.status === "active") {
          setPhase({ name: "active" });
          stop();
          return;
        }

        // Still not active. Only give up on the CLOCK, not on the status
        // value — a subscription could in principle bounce through other
        // non-active states before settling, and this page only cares about
        // "active or not yet".
        if (Date.now() >= deadline) {
          setPhase({ name: "timed-out" });
          stop();
          return;
        }

        setPhase({ name: "checking" });
      } catch (err) {
        if (cancelled) return;

        if (err instanceof ApiError && err.status === 404) {
          setPhase({ name: "not-found" });
          stop();
          return;
        }

        // A transient network blip should not give up on one failed poll —
        // an abandoned tab is the only thing the timeout above needs to guard
        // against, and that clock keeps running regardless.
        if (Date.now() >= deadline) {
          setPhase({
            name: "error",
            message: err instanceof Error ? err.message : "gagal memeriksa status",
          });
          stop();
        }
      }
    }

    poll();
    intervalId = setInterval(poll, pollIntervalMs);

    return () => {
      cancelled = true;
      stop();
    };
  }, [subscriptionId, pollIntervalMs, timeoutMs]);

  return (
    <main style={styles.page}>
      {phase.name === "checking" ? (
        <>
          <h1 style={styles.heading}>Menunggu pembayaran...</h1>
          <p>Kami sedang memeriksa status pembayaran Anda. Halaman ini akan memperbarui otomatis.</p>
          <Spinner />
        </>
      ) : null}

      {phase.name === "active" ? (
        <>
          <h1 style={styles.heading}>Pembayaran berhasil!</h1>
          <p>Keanggotaan Anda sudah aktif. Anda akan segera menerima akses melalui WhatsApp.</p>
        </>
      ) : null}

      {phase.name === "timed-out" ? (
        <>
          <h1 style={styles.heading}>Pembayaran belum kami terima</h1>
          <p>
            Jika Anda sudah membayar, mohon tunggu beberapa menit — konfirmasi dari bank terkadang
            butuh waktu. Jika belum membayar, silakan coba lagi lewat tautan checkout yang sama.
            Jika masalah berlanjut, hubungi penyelenggara komunitas melalui WhatsApp.
          </p>
        </>
      ) : null}

      {phase.name === "not-found" ? (
        <>
          <h1 style={styles.heading}>Status tidak ditemukan</h1>
          <p>Tautan ini mungkin salah atau sudah tidak berlaku.</p>
        </>
      ) : null}

      {phase.name === "error" ? (
        <>
          <h1 style={styles.heading}>Gagal memeriksa status</h1>
          <p>{phase.message}</p>
        </>
      ) : null}
    </main>
  );
}

/**
 * No global stylesheet exists in this app (see Task 8's `apps/web/index.html`
 * — plain inline styles throughout), so the `@keyframes` this spinner needs
 * is injected right here rather than left dangling on an "animation" property
 * that would otherwise silently do nothing.
 */
function Spinner() {
  return (
    <>
      <style>{"@keyframes diudara-spin { to { transform: rotate(360deg); } }"}</style>
      <div style={styles.spinner} aria-hidden="true" />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 480,
    margin: "0 auto",
    padding: "48px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    textAlign: "center",
  },
  heading: {
    fontSize: "1.5rem",
    marginBottom: 4,
  },
  spinner: {
    margin: "24px auto 0",
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "3px solid #ddd",
    borderTopColor: "#16a34a",
    animation: "diudara-spin 0.8s linear infinite",
  },
};
