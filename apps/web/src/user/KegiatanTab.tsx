import { useEffect, useState, type KeyboardEvent } from "react";
import { listCommunityEvents, type CommunityEventRow } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import KegiatanEventModal from "./KegiatanEventModal";
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
  /** Gates the "click a date to add a kegiatan" affordance — creation is owner-only (`OWNER_ONLY_TYPES` in the API's `community-feed.ts`). */
  viewerIsOwner?: boolean;
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

type ModalTarget = { mode: "create"; date: string } | { mode: "detail"; postId: string };

/**
 * The **Kegiatan** tab of `/komunitas/:slug` — a month grid with an agenda
 * beneath it.
 *
 * **ONE fetch, rendered twice.** The grid and the agenda read the same array.
 * Two fetches for one month's data would be two chances to disagree on
 * screen, and the grid has to hold the whole month to render at all — which
 * is also why `GET /communities/:slug/events` is unpaginated.
 *
 * Reading is open; there is no member gate. An owner clicks an empty date to
 * add a kegiatan (`KegiatanEventModal`, create mode) — the ONLY place one is
 * created now; the Diskusi composer's own `kegiatan` type selector predates
 * this and still works identically, since both paths end at the same
 * `POST /communities/:slug/posts`. Anyone — owner or not — clicks an existing
 * chip or agenda row to see its detail; the owner (in practice the same
 * person, since creation is owner-only) gets Edit/Hapus there too.
 *
 * **Local mutation, no refetch** — the same rule every other feed on this
 * project follows. `handleCreated`/`handleUpdated`/`handleDeleted` fold the
 * modal's own write response straight into `events`, re-sorted by
 * `startsAt`: an append out of order would show a newly-added kegiatan in the
 * wrong place in the agenda until the next month change refetched it.
 */
export default function KegiatanTab({ slug, viewerIsOwner = false, now }: Props) {
  // Read ONCE, to seed the month. A re-render with a new `now` must not yank
  // the calendar back from a month the reader has navigated to.
  const [month, setMonth] = useState(() => wibMonthOf((now ?? new Date()).toISOString()));
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [modalTarget, setModalTarget] = useState<ModalTarget | null>(null);

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

  function sorted(events: CommunityEventRow[]): CommunityEventRow[] {
    // ISO 8601 strings sort lexicographically in chronological order — no
    // `Date` parsing needed, same trick `listBetween`'s own ordering relies on.
    return [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  function handleCreated(event: CommunityEventRow): void {
    setState((current) =>
      current.status === "ready" ? { status: "ready", events: sorted([...current.events, event]) } : current
    );
  }

  function handleUpdated(event: CommunityEventRow): void {
    setState((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            events: sorted(current.events.map((row) => (row.postId === event.postId ? event : row))),
          }
        : current
    );
  }

  function handleDeleted(postId: string): void {
    setState((current) =>
      current.status === "ready"
        ? { status: "ready", events: current.events.filter((row) => row.postId !== postId) }
        : current
    );
  }

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
        todayDay={isCurrentMonth ? todayWib.day : null}
        viewerIsOwner={viewerIsOwner}
        onAddClick={(day) => setModalTarget({ mode: "create", date: `${month}-${String(day).padStart(2, "0")}` })}
        onEventClick={(postId) => setModalTarget({ mode: "detail", postId })}
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
              <button type="button" onClick={() => setModalTarget({ mode: "detail", postId: event.postId })}>
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
              </button>
            </li>
          ))}
        </ul>
      )}

      {modalTarget !== null ? (
        <KegiatanEventModal
          slug={slug}
          target={modalTarget}
          onClose={() => setModalTarget(null)}
          onCreated={handleCreated}
          onUpdated={handleUpdated}
          onDeleted={handleDeleted}
        />
      ) : null}
    </section>
  );
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
  todayDay,
  viewerIsOwner,
  onAddClick,
  onEventClick,
}: {
  month: string;
  byDay: Map<number, CommunityEventRow[]>;
  todayDay: number | null;
  viewerIsOwner: boolean;
  onAddClick: (day: number) => void;
  onEventClick: (postId: string) => void;
}) {
  const lead = firstWeekdayOfWibMonth(month);
  const days = daysInWibMonth(month);
  const cells: (number | null)[] = [
    ...Array<null>(lead).fill(null),
    ...Array.from({ length: days }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  function onCellKeyDown(day: number, event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onAddClick(day);
  }

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
            // Only an owner's cells are clickable — a plain member or a
            // signed-out visitor gets a static day, since `CreateCommunityPost`
            // would refuse them a `kegiatan` anyway (403).
            role={viewerIsOwner ? "button" : undefined}
            tabIndex={viewerIsOwner ? 0 : undefined}
            aria-label={viewerIsOwner ? `Tambah kegiatan tanggal ${day}` : undefined}
            onClick={viewerIsOwner ? () => onAddClick(day) : undefined}
            onKeyDown={viewerIsOwner ? (event) => onCellKeyDown(day, event) : undefined}
            key={day}
          >
            <span className="kegiatan-day-number">{day}</span>
            {items.slice(0, CHIPS_PER_DAY).map((event) => (
              <button
                type="button"
                className="kegiatan-chip"
                key={event.postId}
                onClick={(domEvent) => {
                  // Stops the click reaching the cell's own "add" handler
                  // above — opening an existing event must never also pop
                  // the create modal.
                  domEvent.stopPropagation();
                  onEventClick(event.postId);
                }}
              >
                {event.title}
              </button>
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
