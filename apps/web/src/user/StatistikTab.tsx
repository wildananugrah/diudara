import { useEffect, useState } from "react";
import { getCommunityStats, type CommunityStats } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { formatRupiah } from "../api";
import { wibMonthLabel } from "./wibDate";
import { formatRelativeTime } from "./relativeTime";

interface Props {
  slug: string;
  /** Injected clock, the rule every dated component here follows. */
  now?: Date;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; stats: CommunityStats };

/**
 * The **Statistik** tab — the owner's dashboard.
 *
 * Rendered only for the owner (`CommunityPage` decides that), and the server
 * refuses anyone else with a 403 regardless.
 */
export default function StatistikTab({ slug, now }: Props) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const clock = now ?? new Date();

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    getCommunityStats(slug)
      .then((stats) => {
        if (!cancelled) setLoad({ status: "ready", stats });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: describeRequestFailure(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (load.status === "loading") return <p>Memuat...</p>;
  if (load.status === "error") {
    return (
      <p className="form-error" role="alert">
        {load.message}
      </p>
    );
  }

  const { stats } = load;

  return (
    <section className="statistik-tab">
      <dl className="stat-tiles">
        <StatTile label="Pendapatan" value={formatRupiah(stats.totalRevenue)} />
        <StatTile label="Anggota" value={String(stats.memberCount)} />
        <StatTile label="Anggota baru bulan ini" value={String(stats.newMembersThisMonth)} />
        <StatTile label="Pembayaran berhasil" value={formatRate(stats.paymentSuccessRate)} />
        {/* The definition is ON THE TILE. "Churn" without a period is a number
            nobody can act on, and this one is lifetime because nothing records
            when a subscription's status changed. */}
        <StatTile label="Churn (sepanjang waktu)" value={formatRate(stats.churnRate)} />
      </dl>

      <RevenueChart points={stats.revenueByMonth} />

      <section className="stat-panel">
        <h4>Tingkatan</h4>
        {stats.tierDistribution.length === 0 ? (
          <p className="empty">Belum ada tingkatan.</p>
        ) : (
          <ul className="tier-bars">
            {stats.tierDistribution.map((tier) => (
              <li key={tier.tierId}>
                <span className="tier-bar-label">{tier.name}</span>
                <span className="tier-bar-track">
                  <span
                    className="tier-bar-fill"
                    style={{ width: `${percentOf(tier.subscriberCount, maxCount(stats))}%` }}
                  />
                </span>
                <span className="tier-bar-value">{tier.subscriberCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="stat-panel">
        <h4>Anggota terbaru</h4>
        {stats.recentMembers.length === 0 ? (
          <p className="empty">Belum ada anggota.</p>
        ) : (
          <ul className="card-list">
            {stats.recentMembers.map((member) => (
              <li className="card recent-member" key={member.handle}>
                <span>
                  <span className="recent-member-name">{member.displayName}</span>
                  <span className="muted"> @{member.handle}</span>
                </span>
                <span className="muted">
                  {formatRelativeTime(member.joinedAt, clock)} · {STANDING_LABEL[member.standing]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

const STANDING_LABEL: Record<"member" | "lapsed" | "none", string> = {
  member: "berlangganan",
  lapsed: "langganan berakhir",
  // The COMMON case — joining is free, so most members never subscribe. It
  // says "gratis", not "tidak aktif": they are a perfectly real member.
  none: "gratis",
};

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * `null` renders as an em dash and says nothing. It is NOT `0%`: a community
 * with no transactions has no success rate, and "0%" would read as total
 * failure.
 */
function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  // One decimal, Indonesian comma — matching `formatBytes` and `formatRupiah`.
  return `${(rate * 100).toFixed(1).replace(".", ",")}%`;
}

function maxCount(stats: CommunityStats): number {
  return Math.max(1, ...stats.tierDistribution.map((tier) => tier.subscriberCount));
}

function percentOf(value: number, max: number): number {
  return max === 0 ? 0 : (value / max) * 100;
}

/**
 * Six months of revenue as CSS-grid bars.
 *
 * **A bar chart, not a line.** Six discrete months compared by magnitude is
 * what bars are for; a line implies a continuous reading between points that
 * monthly totals do not have.
 *
 * **ONE hue, no legend.** A single series needs none — the heading names it,
 * and a legend box for one thing is furniture. That also means no categorical
 * palette and no colourblind-separation problem to solve: there is only one
 * mark colour, and it is the app's own `--langit` against the card surface.
 *
 * **No charting dependency.** Six bars is a grid and some heights; pulling in
 * a library to draw them is the kind of addition this repo does not make.
 *
 * Every bar carries its own `title`, so the exact rupiah is reachable on
 * hover, and the table below is the non-visual reading of the same numbers.
 */
function RevenueChart({ points }: { points: { month: string; amount: number }[] }) {
  const peak = Math.max(1, ...points.map((point) => point.amount));
  const empty = points.every((point) => point.amount === 0);

  return (
    <section className="stat-panel">
      <h4>Pendapatan 6 bulan terakhir</h4>
      {empty ? (
        // Not an empty chart: six zero-height bars look like a rendering
        // failure. A sentence is honest about there being nothing yet.
        <p className="empty">Belum ada pendapatan.</p>
      ) : (
        <>
          <ol className="revenue-chart" aria-hidden>
            {points.map((point) => (
              <li key={point.month} title={`${wibMonthLabel(point.month)}: ${formatRupiah(point.amount)}`}>
                <span
                  className="revenue-bar"
                  // Anchored to the baseline and given a minimum sliver, so a
                  // small-but-real month is visibly present rather than
                  // indistinguishable from zero.
                  style={{ height: `${Math.max(2, (point.amount / peak) * 100)}%` }}
                />
                <span className="revenue-month">{point.month.slice(5)}</span>
              </li>
            ))}
          </ol>
          {/* The same numbers, readable without seeing the chart. `aria-hidden`
              on the bars above is what stops a screen reader announcing the
              series twice. */}
          <table className="revenue-table">
            <caption className="muted">Pendapatan per bulan</caption>
            <tbody>
              {points.map((point) => (
                <tr key={point.month}>
                  <th scope="row">{wibMonthLabel(point.month)}</th>
                  <td>{formatRupiah(point.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
