import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCommunityEvents, type CommunityEventRow } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import {
  WEEKDAYS_ID,
  daysInWibMonth,
  firstWeekdayOfWibMonth,
  shiftWibMonth,
  wibMonthLabel,
  wibMonthOf,
  wibParts,
  wibTimeLabel,
} from "./wibDate";

interface Props {
  slug: string;
  /**
   * Injected clock, the same reason every other dated component on this
   * project takes one: a tab that reads `Date.now()` itself cannot be tested
   * at the WIB midnight its whole month calculation turns on.
   */
  now?: Date;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; events: CommunityEventRow[] };

/**
 * The **Kegiatan** tab of `/komunitas/:slug` — a month grid with an agenda
 * beneath it.
 *
 * **ONE fetch, rendered twice.** The grid and the agenda read the same array.
 * Two fetches for one month's data would be two chances to disagree on
 * screen, and the grid has to hold the whole month to render at all — which
 * is also why `GET /communities/:slug/events` is unpaginated.
 *
 * Reading is open; there is no member gate and no composer here. An owner
 * creates an event from the Diskusi tab's composer, which is where every
 * other post type is created — a second composer on this tab would be a
 * second thing to keep in visual sync.
 */
export default function KegiatanTab({ slug, now }: Props) {
  // Read ONCE, to seed the month. A re-render with a new `now` must not yank
  // the calendar back from a month the reader has navigated to.
  const [month, setMonth] = useState(() => wibMonthOf((now ?? new Date()).toISOString()));
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listCommunityEvents(slug, month)
      .then((page) => {
        if (!cancelled) setState({ status: "ready", events: page.events });
      })
      .catch((error: unknown) => {
        // An error, NOT an empty month. A calendar that renders "Belum ada
        // kegiatan" over a failed request tells the reader their community
        // has nothing scheduled, which is a lie they cannot detect.
        if (!cancelled) setState({ status: "error", message: describeRequestFailure(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug, month]);

  const events = state.status === "ready" ? state.events : [];
  const todayWib = wibParts((now ?? new Date()).toISOString());
  const isCurrentMonth = wibMonthOf((now ?? new Date()).toISOString()) === month;

  // Bucketed by WIB day, not UTC — `wibParts` is the whole reason this module
  // exists. An event at 00:30 WIB on the 16th is `2026-09-15T17:30Z`, and a
  // grid keyed on UTC parts files it under the 15th.
  const byDay = new Map<number, CommunityEventRow[]>();
  for (const event of events) {
    const day = wibParts(event.startsAt).day;
    const existing = byDay.get(day);
    if (existing === undefined) byDay.set(day, [event]);
    else existing.push(event);
  }

  return (
    <section className="kegiatan-tab">
      <header className="kegiatan-header">
        <button
          type="button"
          aria-label="Bulan sebelumnya"
          onClick={() => setMonth(shiftWibMonth(month, -1))}
        >
          ‹
        </button>
        <h3>{wibMonthLabel(month)}</h3>
        <button
          type="button"
          aria-label="Bulan berikutnya"
          onClick={() => setMonth(shiftWibMonth(month, 1))}
        >
          ›
        </button>
      </header>

      <MonthGrid
        month={month}
        byDay={byDay}
        slug={slug}
        todayDay={isCurrentMonth ? todayWib.day : null}
      />

      {state.status === "error" ? (
        <p className="error" role="alert">
          {state.message}
        </p>
      ) : state.status === "ready" && events.length === 0 ? (
        <p className="empty">Belum ada kegiatan bulan ini.</p>
      ) : (
        <ul className="card-list kegiatan-agenda">
          {events.map((event) => (
            <li className="card kegiatan-agenda-row" key={event.postId}>
              <Link to={eventHref(slug, event.postId)}>
                <span className="kegiatan-agenda-date">
                  <span className="kegiatan-agenda-day">{wibParts(event.startsAt).day}</span>
                  <span className="kegiatan-agenda-weekday">
                    {WEEKDAYS_ID[wibParts(event.startsAt).weekday]}
                  </span>
                </span>
                <span className="kegiatan-agenda-detail">
                  <span className="kegiatan-agenda-title">{event.title}</span>
                  <span className="muted">
                    {wibTimeLabel(event.startsAt)}
                    {event.endsAt === null ? "" : `–${wibTimeLabel(event.endsAt)}`}
                    {event.location === null ? "" : ` · ${event.location}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function eventHref(slug: string, postId: string): string {
  return `/komunitas/${encodeURIComponent(slug)}/kegiatan/${encodeURIComponent(postId)}`;
}

/** How many chips a day cell shows before collapsing the rest into a count. */
const CHIPS_PER_DAY = 2;

/**
 * Seven columns, Monday-first, padded at the front to the month's first
 * weekday and at the back to a whole number of weeks — the reference's own
 * construction, which keeps every row the same length so the grid does not
 * ragged-end.
 */
function MonthGrid({
  month,
  byDay,
  slug,
  todayDay,
}: {
  month: string;
  byDay: Map<number, CommunityEventRow[]>;
  slug: string;
  todayDay: number | null;
}) {
  const lead = firstWeekdayOfWibMonth(month);
  const days = daysInWibMonth(month);
  const cells: (number | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="kegiatan-grid">
      {WEEKDAYS_ID.map((label) => (
        <div className="kegiatan-weekday" data-testid="kegiatan-weekday" key={label}>
          {label}
        </div>
      ))}
      {cells.map((day, index) => {
        if (day === null) {
          // A padding cell, not a day. `aria-hidden` so a screen reader walks
          // 30 days rather than 35 cells, five of which are nothing.
          return <div className="kegiatan-day kegiatan-day-empty" aria-hidden key={`pad-${index}`} />;
        }
        const items = byDay.get(day) ?? [];
        return (
          <div
            className="kegiatan-day"
            data-testid={`kegiatan-day-${day}`}
            // `undefined` rather than `false`: React omits the attribute
            // entirely, so `getAttribute` answers null on every other day and
            // the CSS hook matches only the real one.
            data-today={day === todayDay ? "true" : undefined}
            key={day}
          >
            <span className="kegiatan-day-number">{day}</span>
            {items.slice(0, CHIPS_PER_DAY).map((event) => (
              <Link className="kegiatan-chip" to={eventHref(slug, event.postId)} key={event.postId}>
                {event.title}
              </Link>
            ))}
            {items.length > CHIPS_PER_DAY ? (
              <span className="kegiatan-more muted">+{items.length - CHIPS_PER_DAY} lagi</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
