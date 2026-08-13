import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, fetchCommunity, fetchSubscriptionStatus } from "../api";

/** `community.accessMode` value whose members joined by asking, not by paying. */
const REQUEST_ACCESS_MODE = "request";

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
  | { name: "active"; watchUrl?: string }
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
  const { slug, subscriptionId } = useParams<{ slug: string; subscriptionId: string }>();
  const [phase, setPhase] = useState<Phase>({ name: "checking" });
  /**
   * WAS THIS MEMBERSHIP PAID FOR, OR APPROVED FOR FREE?
   *
   * Every string on this page used to assume a payment. `RequestStatusPage`
   * deliberately links an APPROVED FREE MEMBER here ("Lihat status
   * keanggotaan"), so they were told "Pembayaran berhasil!" about a payment
   * they never made — deterministic for every one of them, since their
   * subscription is `active` on the very first poll. "Menunggu pembayaran..."
   * is on the same path, rendered before that poll resolves.
   *
   * Read from the COMMUNITY, whose slug is already in this page's own route
   * (`/c/:slug/status/:subscriptionId`), rather than from the subscription
   * endpoint: `GetSubscriptionStatus` deliberately returns nothing but the
   * status and an optional watch URL, and widening that contract to answer a
   * copy question would be the wrong trade. `accessMode` is already public on
   * `GET /c/:slug`.
   *
   * `null` means "not known" and takes the PAID wording — the wording this page
   * has always used. An archived community 404s its public page, and a paying
   * member is overwhelmingly the likelier reader of a status URL in that state.
   */
  const [accessMode, setAccessMode] = useState<string | null>(null);
  const isFree = accessMode === REQUEST_ACCESS_MODE;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetchCommunity(slug)
      .then((community) => {
        if (!cancelled) setAccessMode(community.accessMode);
      })
      // Deliberately silent: this lookup only chooses between two wordings, and
      // failing it must never disturb the status this page exists to report.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!subscriptionId) {
      setPhase({ name: "not-found" });
      return;
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const deadline = Date.now() + timeoutMs;
    // Set the instant the subscription is FIRST seen active, and never
    // cleared afterwards. Once true, no later poll — whether it 404s, throws,
    // or simply times out — is allowed to downgrade the phase away from
    // "active": the member has genuinely paid, and a transient blip while
    // this page keeps polling FOR A watchUrl (see below) must not replace
    // "Pembayaran berhasil!" with an error or a timeout screen.
    let reachedActive = false;

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
          reachedActive = true;
          setPhase({ name: "active", watchUrl: result.watchUrl });
          // A member who paid BEFORE the creator went live gets `active`
          // with no `watchUrl` — this page is "the only place a member can
          // reach a stream until Fonnte is configured" (Task 8 brief), so
          // stopping here permanently would mean the "Tonton sekarang" link
          // never appears in this tab even once the creator does go live.
          // Keep polling, bounded by the SAME deadline an abandoned tab was
          // always going to hit, until either a watchUrl shows up (nothing
          // left to wait for) or the deadline arrives (give up quietly —
          // the success screen itself is not in question, only the link).
          if (result.watchUrl || Date.now() >= deadline) {
            stop();
          }
          return;
        }

        // Once the success screen has been shown, a later poll reporting
        // anything else is noise from the watchUrl-only polling window
        // above, not a reason to take "Pembayaran berhasil!" away — just
        // let the clock (not the status value) decide when to stop asking.
        if (reachedActive) {
          if (Date.now() >= deadline) stop();
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

        if (reachedActive) {
          if (Date.now() >= deadline) stop();
          return;
        }

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
          <h1 style={styles.heading}>
            {isFree ? "Menunggu persetujuan..." : "Menunggu pembayaran..."}
          </h1>
          <p>
            {isFree
              ? "Kami sedang memeriksa status keanggotaan Anda. Halaman ini akan memperbarui otomatis."
              : "Kami sedang memeriksa status pembayaran Anda. Halaman ini akan memperbarui otomatis."}
          </p>
          <Spinner />
        </>
      ) : null}

      {phase.name === "active" ? (
        <>
          <h1 style={styles.heading}>{isFree ? "Keanggotaan aktif!" : "Pembayaran berhasil!"}</h1>
          <p>Keanggotaan Anda sudah aktif. Anda akan segera menerima akses melalui WhatsApp.</p>
          {phase.watchUrl ? (
            <p>
              <Link to={phase.watchUrl} style={styles.watchLink}>
                Tonton sekarang
              </Link>
            </p>
          ) : null}
        </>
      ) : null}

      {phase.name === "timed-out" ? (
        <>
          <h1 style={styles.heading}>
            {isFree ? "Keanggotaan ini belum aktif" : "Pembayaran belum kami terima"}
          </h1>
          <p>
            {isFree ? (
              // A free member reaches this only if their membership is not
              // active — approved and since revoked, or never approved. There is
              // no checkout for them to retry, so sending them to one (as this
              // page used to) is an instruction they cannot follow.
              <>
                Keanggotaan Anda di komunitas ini sedang tidak aktif. Hubungi penyelenggara
                komunitas melalui WhatsApp untuk menanyakan status keanggotaan Anda.
              </>
            ) : (
              <>
                Jika Anda sudah membayar, mohon tunggu beberapa menit — konfirmasi dari bank
                terkadang butuh waktu. Jika belum membayar, silakan coba lagi lewat tautan
                checkout yang sama. Jika masalah berlanjut, hubungi penyelenggara komunitas
                melalui WhatsApp.
              </>
            )}
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
  watchLink: {
    display: "inline-block",
    marginTop: 8,
    padding: "10px 20px",
    borderRadius: 8,
    backgroundColor: "#16a34a",
    color: "#fff",
    textDecoration: "none",
    fontWeight: 600,
  },
};
