import { useCallback, useEffect, useState } from "react";
import { listSubscribers, revokeMembership, type SubscriberEntry } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { formatRelativeTime } from "./relativeTime";

/**
 * Removing a member is a WRITE the owner initiates, so this component owns a
 * little state of its own: which handle is in flight (so its button can say
 * so and refuse a second press), and a failure message.
 *
 * On success it RE-READS the list rather than splicing the row out locally.
 * The server is what decides who is a member — a local splice would be this
 * screen's guess at the outcome, and the two would disagree the moment
 * anything else changed a membership.
 */
type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; subscribers: SubscriberEntry[] };

export interface SubscriberListProps {
  /**
   * Injected clock for `formatRelativeTime`, same reason and same default as
   * `PostCard`'s own `now` prop: a component that reads `Date.now()` itself
   * cannot be tested at a boundary. Defaults to the real clock so callers
   * outside a test don't have to pass one.
   */
  now?: Date;
}

/**
 * **Pengaturan's subscriber list — Task 6 of Phase 5b (spec §8).** A creator's
 * own view of who currently subscribes to them.
 *
 * A SEPARATE component from `MembershipSettings`, rendered alongside it
 * rather than folded in: `MembershipSettings.test.tsx` stubs exactly two
 * endpoints (`GET /users/me/payout`, `GET /users/me/tiers`) across roughly
 * thirty tests, several with their own bespoke `fetch` mocks that answer
 * nothing else. Adding a third unconditional fetch inside that component
 * would have meant touching every one of those mocks for a change this task
 * does not otherwise require; a standalone component with its own mount
 * effect leaves that file untouched.
 *
 * ONLY CURRENTLY SUBSCRIBED people appear — the server's own definition,
 * mirrored nowhere on this side: this component renders exactly what
 * `GET /users/me/subscribers` sends, and does not itself decide who counts
 * as current. See `ListSubscribers`'s docstring on the API side for why that
 * boundary is `current_period_end > now`, not merely `status = 'active'`.
 *
 * `subscribers` is read defensively (`Array.isArray`) rather than trusted
 * outright: this is a screen, not a contract test, and a response that
 * cannot be parsed into the expected shape should read as empty rather than
 * throw past this component and take the rest of Pengaturan down with it.
 */
export default function SubscriberList({ now }: SubscriberListProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** The handle whose removal is in flight, so its own button can say so and refuse a second press. */
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const clock = now ?? new Date();

  const reload = useCallback(async (): Promise<void> => {
    const result = await listSubscribers();
    const subscribers = Array.isArray(result.subscribers) ? result.subscribers : [];
    setLoad({ status: "ready", subscribers });
  }, []);

  /**
   * Removes a member, then RE-READS the list rather than splicing the row out
   * locally: the server decides who is a member, and a local splice would be
   * this screen's guess at the outcome.
   */
  const revoke = useCallback(
    async (handle: string): Promise<void> => {
      setRevoking(handle);
      setRevokeError(null);
      try {
        await revokeMembership(handle);
        await reload();
      } catch (err: unknown) {
        setRevokeError(describeRequestFailure(err));
      } finally {
        setRevoking(null);
      }
    },
    [reload]
  );

  useEffect(() => {
    let cancelled = false;
    listSubscribers()
      .then((result) => {
        if (cancelled) return;
        const subscribers = Array.isArray(result.subscribers) ? result.subscribers : [];
        setLoad({ status: "ready", subscribers });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: `Gagal memuat daftar pelanggan. ${describeRequestFailure(err)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="card stack" aria-labelledby="subscribers-heading">
      <h2 id="subscribers-heading">Pelanggan Anda</h2>
      <p className="muted">Orang yang saat ini berlangganan keanggotaan Anda.</p>

      {load.status === "loading" ? <p className="muted">Memuat daftar pelanggan...</p> : null}

      {load.status === "error" ? (
        <p className="form-error" role="alert">
          {load.message}
        </p>
      ) : null}

      {load.status === "ready" ? (
        load.subscribers.length === 0 ? (
          <p className="muted" data-testid="subscriber-list-empty">
            Belum ada pelanggan yang berlangganan saat ini.
          </p>
        ) : (
          <>
          {revokeError !== null ? (
            <p className="form-error" role="alert">
              {revokeError}
            </p>
          ) : null}
          <ul className="card-list" data-testid="subscriber-list">
            {load.subscribers.map((subscriber) => (
              <li key={subscriber.handle} className="spread">
                <span>{subscriber.displayName}</span>
                <span className="muted">@{subscriber.handle}</span>
                <span className="muted">{`Sejak ${formatRelativeTime(subscriber.since, clock)}`}</span>
                {/*
                  OFFERED ONLY FOR A FREE MEMBERSHIP, and that is the whole
                  reason `kind` is on the wire. A paid membership cannot be
                  revoked — stopping it mid-period takes money for a service
                  that then stops, and this product has no refund path — so the
                  server answers 409. Rendering the button anyway would offer an
                  action that fails, which is the shape of defect this codebase
                  has spent the week removing: a badge that went nowhere, a CTA
                  that promised a membership nobody offered.

                  The paid case says nothing at all rather than showing a
                  disabled control: there is no action to take here, and a
                  greyed-out button invites a hunt for the way to enable it.
                */}
                {subscriber.kind === "free" ? (
                  <button
                    type="button"
                    className="button-quiet btn btn-ghost btn-sm"
                    data-testid={`revoke-${subscriber.handle}`}
                    disabled={revoking === subscriber.handle}
                    onClick={() => void revoke(subscriber.handle)}
                  >
                    {revoking === subscriber.handle ? "Mengeluarkan..." : "Keluarkan"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          </>
        )
      ) : null}
    </section>
  );
}
