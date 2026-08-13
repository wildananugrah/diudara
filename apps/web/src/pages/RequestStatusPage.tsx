import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, fetchJoinRequestStatus, type JoinRequestStatus } from "../api";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; request: JoinRequestStatus };

/**
 * `GET /c/:slug/request/:joinRequestId` — where a member lands right after
 * asking to join a free community (`CheckoutPage` in `request` mode). The
 * endpoint answers with only `status`, `communitySlug` and `subscriptionId`
 * — never the member's name or WhatsApp number, since this URL is guessable
 * the same way the subscription status URL is. See
 * apps/api/src/application/use-cases/request-to-join.ts's `GetJoinRequestStatus`.
 *
 * No polling here (unlike `StatusPage`): a decision only changes when the
 * owner acts, which the member hears about over WhatsApp, not by watching
 * this tab.
 */
export default function RequestStatusPage() {
  const { slug, joinRequestId } = useParams<{ slug: string; joinRequestId: string }>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!slug || !joinRequestId) {
      setLoad({ status: "not-found" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    fetchJoinRequestStatus(slug, joinRequestId)
      .then((request) => {
        if (!cancelled) setLoad({ status: "ready", request });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setLoad({ status: "not-found" });
        } else {
          setLoad({ status: "error", message: err instanceof Error ? err.message : "failed to load request status" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, joinRequestId]);

  if (load.status === "loading") {
    return <Centered>Memuat...</Centered>;
  }

  if (load.status === "not-found") {
    return (
      <Centered>
        <h1 style={styles.heading}>Permintaan tidak ditemukan</h1>
        <p>Tautan ini mungkin salah atau sudah tidak berlaku.</p>
      </Centered>
    );
  }

  if (load.status === "error") {
    return (
      <Centered>
        <h1 style={styles.heading}>Gagal memeriksa status</h1>
        <p>{load.message}</p>
      </Centered>
    );
  }

  const { request } = load;

  if (request.status === "approved") {
    return (
      <Centered>
        <h1 style={styles.heading}>Permintaan disetujui</h1>
        <p>Permintaan Anda disetujui. Cek WhatsApp Anda untuk tautan undangan grup.</p>
        {/* Non-null only once approved AND the subscription it produced is
            still current — see JoinRequestStatus's own docstring. A link
            built from a null id would 404 for a member who has done nothing
            wrong, so it renders only when the id is actually present. This
            is the ONLY route an approved free member has to "Tonton
            sekarang" once a stream goes live. */}
        {request.subscriptionId ? (
          <p>
            <Link to={`/c/${request.communitySlug}/status/${request.subscriptionId}`} style={styles.link}>
              Lihat status keanggotaan
            </Link>
          </p>
        ) : null}
      </Centered>
    );
  }

  if (request.status === "rejected") {
    return (
      <Centered>
        <h1 style={styles.heading}>Permintaan belum disetujui</h1>
        {/* No reason given — the owner never gave one, and rejection is
            silent by design. Do not invent one here. */}
        <p>Permintaan Anda belum dapat disetujui saat ini.</p>
      </Centered>
    );
  }

  // "pending" — the only status left, and the default for anything
  // unanticipated: never claim approval or rejection without the API
  // actually saying so.
  return (
    <Centered>
      <h1 style={styles.heading}>Menunggu persetujuan</h1>
      <p>
        Permintaan Anda sudah dikirim dan menunggu persetujuan pemilik komunitas. Anda akan menerima
        tautan undangan grup lewat WhatsApp setelah disetujui.
      </p>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main style={styles.page}>{children}</main>;
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
  link: {
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
