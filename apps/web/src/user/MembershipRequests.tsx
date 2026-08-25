import { useEffect, useState } from "react";
import {
  approveMembershipRequest,
  listMembershipRequests,
  rejectMembershipRequest,
  type MembershipRequestEntry,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; requests: MembershipRequestEntry[] };

/**
 * **Pengaturan's membership-requests queue — Task 7 of "free memberships"
 * (spec §2.4).** A creator's own queue of pending free-tier requests: what
 * `StartUserSubscription`'s free path writes when somebody asks to join a
 * `priceAmount: 0` tier, waiting on this owner to admit or turn away one at a
 * time. A free tier is invitation-only in that sense — never self-service the
 * way a paid purchase is.
 *
 * A SEPARATE component from `MembershipSettings`, mounted alongside it in
 * `SettingsPage.tsx` — the same reason `SubscriberList` is its own component
 * rather than folded in: it loads its own list independently, so a failure
 * here cannot take the rest of Pengaturan down with it, and adding a fetch
 * effect here never has to touch `MembershipSettings.test.tsx`'s existing
 * mocks.
 *
 * Approving and rejecting both act OPTIMISTICALLY-BY-RESULT, not by refetching
 * the whole list: on success the row is simply filtered out of local state.
 * The server is still the sole arbiter of whether the action actually
 * happened — a failed approve/reject leaves the row in place and shows a
 * Bahasa sentence, never silently drops it.
 */
export default function MembershipRequests() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMembershipRequests()
      .then((result) => {
        if (cancelled) return;
        const requests = Array.isArray(result.requests) ? result.requests : [];
        setLoad({ status: "ready", requests });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: `Gagal memuat permintaan keanggotaan. ${describeRequestFailure(err)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dropRequest(id: string) {
    setLoad((current) =>
      current.status === "ready"
        ? { status: "ready", requests: current.requests.filter((r) => r.id !== id) }
        : current
    );
  }

  async function handleApprove(id: string) {
    setActionError(null);
    setPendingId(id);
    try {
      await approveMembershipRequest(id);
      dropRequest(id);
    } catch (err) {
      setActionError(`Gagal menyetujui permintaan. ${describeRequestFailure(err)}`);
    } finally {
      setPendingId(null);
    }
  }

  async function handleReject(id: string) {
    setActionError(null);
    setPendingId(id);
    try {
      await rejectMembershipRequest(id);
      dropRequest(id);
    } catch (err) {
      setActionError(`Gagal menolak permintaan. ${describeRequestFailure(err)}`);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="card stack" aria-labelledby="membership-requests-heading">
      <h2 id="membership-requests-heading">Permintaan keanggotaan</h2>
      <p className="muted">Orang yang meminta bergabung ke tingkatan gratis Anda.</p>

      {load.status === "loading" ? (
        <p className="muted">Memuat permintaan keanggotaan...</p>
      ) : null}

      {load.status === "error" ? (
        <p className="form-error" role="alert">
          {load.message}
        </p>
      ) : null}

      {actionError !== null ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {load.status === "ready" ? (
        load.requests.length === 0 ? (
          <p className="muted" data-testid="membership-requests-empty">
            Belum ada permintaan.
          </p>
        ) : (
          <ul className="card-list" data-testid="membership-requests-list">
            {load.requests.map((request) => (
              <li key={request.id} className="spread">
                <span>{request.subscriberDisplayName}</span>
                <span className="muted">@{request.subscriberHandle}</span>
                <span className="muted">{request.tierName}</span>
                <div>
                  <button
                    type="button"
                    className="button-primary"
                    disabled={pendingId === request.id}
                    onClick={() => void handleApprove(request.id)}
                  >
                    Setujui
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={pendingId === request.id}
                    onClick={() => void handleReject(request.id)}
                  >
                    Tolak
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
