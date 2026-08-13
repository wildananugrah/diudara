import { useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../apiClient";
import { formatDateTime } from "../format";
import { CommunityHeader, EmptyState, ErrorPanel, NotFoundPanel } from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import type { ActivityEntry, ActivityPage as ActivityFeedPage, Community } from "../types";

/** Entries per request. The API's own default, and its cap is 100. */
const PAGE_LIMIT = 25;

/**
 * What has happened in a community, newest first.
 *
 * THIS PAGE FILTERS NOTHING AND LABELS NOTHING. Both decisions live in
 * `apps/api/src/domain/activity-feed.ts`: which of the 21 event types that module
 * knows about (`ALL_EVENT_TYPES` in its own test) a creator sees at all — an
 * allowlist of 15, so `renewal_reminder_queued` is off it and ONE reminder
 * produces ONE entry rather than two — and what each one says in Indonesian. A
 * second copy of either rule here would be a second place for them to drift, and
 * the failure mode of drift is a creator counting twice as many reminders as were
 * sent, or reading a raw `access_not_revoked` and panicking.
 *
 * What this page owns is PROMINENCE: `severity: "warning"` means automation could
 * not finish and a person has to act, and those entries are the whole reason a
 * creator should open this screen.
 */
export default function ActivityPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [communityLoad] = useCommunity(communityId);

  if (communityLoad.kind === "loading") return <p className="muted">Memuat...</p>;
  if (communityLoad.kind === "error") return <ErrorPanel message={communityLoad.message} />;
  if (communityLoad.data === null) return <NotFoundPanel />;

  return (
    <section>
      <CommunityHeader community={communityLoad.data} />
      <h2>Aktivitas</h2>
      <Feed community={communityLoad.data} />
    </section>
  );
}

function Feed({ community }: { community: Community }) {
  const [load, handle] = useLoad(
    () => apiFetch<ActivityFeedPage>(`/communities/${community.id}/activity?limit=${PAGE_LIMIT}`),
    [community.id]
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  if (load.kind === "loading") return <p className="muted">Memuat aktivitas...</p>;
  if (load.kind === "error") return <ErrorPanel message={load.message} onRetry={handle.reload} />;

  const page = load.data;

  /**
   * The next page, by KEYSET rather than offset.
   *
   * The feed is append-heavy — every payment, reminder, grant and revocation adds
   * a row — so an offset drifts while the creator reads and page two would skip or
   * repeat entries. The cursor anchors on a row that is already on screen.
   */
  async function loadMore() {
    if (page.nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await apiFetch<ActivityFeedPage>(
        `/communities/${community.id}/activity?limit=${PAGE_LIMIT}&before=${encodeURIComponent(
          page.nextCursor
        )}`
      );
      handle.update({
        entries: [...page.entries, ...next.entries],
        nextCursor: next.nextCursor,
      });
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "gagal memuat halaman berikutnya");
    } finally {
      setLoadingMore(false);
    }
  }

  if (page.entries.length === 0) {
    return (
      <EmptyState
        title="Belum ada aktivitas"
        action="Sebarkan tautan checkout komunitas ini (ada di tab “Ringkasan”). Setiap anggota yang bergabung, memperpanjang, atau berhenti akan tercatat di sini."
      />
    );
  }

  const warnings = page.entries.filter((entry) => entry.severity === "warning");

  return (
    <div className="stack">
      {warnings.length > 0 ? (
        <div className="notice notice-warning" data-testid="action-required-summary" role="alert">
          <h3>
            {warnings.length} kejadian perlu tindakan Anda
          </h3>
          <p>
            Otomatisasi tidak bisa menyelesaikan {warnings.length} hal di bawah ini — ada anggota
            yang harus Anda masukkan atau keluarkan dari grup secara manual. Jumlah ini hanya
            menghitung entri yang sudah dimuat di halaman ini.
          </p>
        </div>
      ) : null}

      <ul className="feed">
        {page.entries.map((entry) => (
          <FeedItem key={entry.id} entry={entry} />
        ))}
      </ul>

      {moreError !== null ? (
        <p className="form-error" role="alert">
          {moreError}
        </p>
      ) : null}

      {page.nextCursor !== null ? (
        <div>
          <button
            type="button"
            className="button-secondary"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Memuat..." : "Muat lebih banyak"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One entry.
 *
 * A warning is separated from an ordinary event THREE ways, not one: its own
 * background and left border (`.feed-item-warning`), `role="alert"` so a screen
 * reader announces it rather than leaving it in the list, and the API's own label,
 * which begins "PERLU TINDAKAN". Colour alone would be invisible to a colour-blind
 * creator and to anybody skimming, and the cost of skimming past one of these is
 * that somebody who paid never gets into the group, or somebody who stopped paying
 * never leaves it.
 */
function FeedItem({ entry }: { entry: ActivityEntry }) {
  const isWarning = entry.severity === "warning";
  return (
    <li
      className={`feed-item${isWarning ? " feed-item-warning" : ""}`}
      data-testid="feed-item"
      {...(isWarning ? { role: "alert" } : {})}
    >
      <div className="feed-label" data-testid="feed-label">
        {entry.label}
      </div>
      <div className="feed-meta">
        {formatDateTime(entry.createdAt)}
        {entry.memberName !== null ? ` · ${entry.memberName}` : ""}
      </div>
    </li>
  );
}
