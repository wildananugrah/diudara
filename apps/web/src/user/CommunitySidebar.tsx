import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCommunityEvents, type CommunityEventRow } from "./apiClient";
import { WEEKDAYS_ID, shiftWibMonth, wibMonthOf, wibParts, wibTimeLabel } from "./wibDate";

/** How many upcoming events the widget shows before the rest are left for the Kegiatan tab. */
const UPCOMING_LIMIT = 3;

/**
 * The Diskusi tab's sidebar — `CommunityHome.tsx` in the design reference,
 * minus the fabricated bits: no "konten" library type, no per-post "Aktif"
 * badge (see this session's own scoped-plan note on `FeedPostCard.tsx`'s mock
 * data).
 *
 * **"Tentang komunitas"** repeats the banner's own description — the
 * reference renders it a second time here rather than only in the banner,
 * and the card is omitted entirely rather than shown empty when there is
 * none, the same rule `CommunityCard`'s own docstring gives.
 *
 * **"Event mendatang"** cannot come from one `GET .../events` call: that
 * endpoint answers ONE WIB month (`wibDate.ts`), and "the next three,
 * whichever month they fall in" may span two. So this reads the current and
 * the next WIB month, merges, drops anything already past `now`, sorts
 * ascending, and takes the first three — no backend change, since two reads
 * bound at two months is cheap and this widget's only job is a short preview
 * (the Kegiatan tab is where the full calendar lives).
 */
export default function CommunitySidebar({
  slug,
  description,
  now,
}: {
  slug: string;
  description: string | null;
  /** Injected clock — see `KegiatanTab`'s own prop for why. */
  now?: Date;
}) {
  const [events, setEvents] = useState<CommunityEventRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const nowIso = (now ?? new Date()).toISOString();
    const thisMonth = wibMonthOf(nowIso);
    const nextMonth = shiftWibMonth(thisMonth, 1);
    Promise.all([listCommunityEvents(slug, thisMonth), listCommunityEvents(slug, nextMonth)])
      .then(([a, b]) => {
        if (cancelled) return;
        const upcoming = [...a.events, ...b.events]
          .filter((event) => event.startsAt >= nowIso)
          .sort((x, y) => x.startsAt.localeCompare(y.startsAt))
          .slice(0, UPCOMING_LIMIT);
        setEvents(upcoming);
      })
      .catch(() => {
        // Silent, like `AnggotaTab`'s own roster read: a sidebar preview that
        // failed is not a reason to break a community page that loaded fine.
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, now]);

  return (
    <aside className="community-sidebar">
      {description === null ? null : (
        <div className="card community-sidebar-card">
          <h4>Tentang komunitas</h4>
          <p className="muted">{description}</p>
        </div>
      )}
      <div className="card community-sidebar-card">
        <h4>Event mendatang</h4>
        {events.length === 0 ? (
          <p className="empty">Belum ada jadwal mendatang.</p>
        ) : (
          <ul className="card-list community-sidebar-events">
            {events.map((event) => (
              <li key={event.postId}>
                <Link to={`/komunitas/${encodeURIComponent(slug)}/kegiatan/${encodeURIComponent(event.postId)}`}>
                  <span className="community-sidebar-event-date">
                    <span className="community-sidebar-event-day">{wibParts(event.startsAt).day}</span>
                    <span className="community-sidebar-event-weekday">
                      {WEEKDAYS_ID[wibParts(event.startsAt).weekday]}
                    </span>
                  </span>
                  <span className="community-sidebar-event-detail">
                    <span className="community-sidebar-event-title">{event.title}</span>
                    <span className="muted">{wibTimeLabel(event.startsAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
