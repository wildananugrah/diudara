import { useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, apiRequest, DashboardApiError } from "../apiClient";
import {
  formatDate,
  formatDateTime,
  memberStatusExplanation,
  memberStatusLabel,
  platformLabel,
} from "../format";
import { CommunityHeader, EmptyState, ErrorPanel, NotFoundPanel } from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import type { Community, MemberRosterPage, MemberRow, RevokeResult } from "../types";

/** Rows per request. The API's own default, and its cap is 100. */
const PAGE_LIMIT = 25;

/** The three statuses a roster row can hold, in the order a creator reads them. */
const STATUSES = ["active", "past_due", "churned"] as const;

/**
 * The statuses a member can be revoked FROM.
 *
 * `churned` is absent because `POST …/revoke` answers 404 when there is no active
 * channel access, and a button whose only outcome is an error is worse than no
 * button. The 404 is still handled — a roster can be stale, and the member may have
 * been revoked in another tab between the load and the click.
 */
const REVOCABLE: ReadonlySet<string> = new Set(["active", "past_due"]);

/**
 * WHY A REMOVAL COULD NOT BE PERFORMED FOR THE CREATOR, in Indonesian.
 *
 * Keys are `RevokeNotAutomatedReason` from
 * apps/api/src/application/use-cases/revoke-channel-access.ts. A lookup rather than
 * interpolation, for the same reason the API's activity labels are: an unrecognised
 * reason falls back to the general warning instead of showing somebody a
 * snake_case identifier they have never seen.
 *
 * Every one of these strings ends by telling the creator THEY have to act. Two of
 * the four are retried by the outbox, and even those say so — a retry that may or
 * may not succeed is not a reason to let a non-payer sit in a paid group while the
 * creator believes they were removed.
 */
const REVOKE_FAILURE_REASONS: Record<string, string> = {
  provider_cannot_gate_access:
    "WhatsApp tidak bisa mengeluarkan anggota dari grup secara otomatis. Keluarkan mereka sendiri dari grup.",
  no_provider_for_platform:
    "Grup ini belum tersambung ke bot DIUDARA (atau id grupnya belum diisi), jadi tidak ada yang bisa dijalankan otomatis. Keluarkan mereka sendiri dari grup.",
  no_provider_member_id_recorded:
    "DIUDARA tidak pernah mencatat akun grup anggota ini — biasanya karena mereka diundang tetapi tidak pernah benar-benar masuk. Periksa grup Anda dan keluarkan mereka bila ternyata ada di dalamnya.",
  provider_error:
    "Panggilan ke penyedia grup gagal. DIUDARA akan mencoba lagi otomatis, tetapi jangan menunggu — periksa grup Anda sekarang.",
};

/** `Content-Disposition: attachment; filename="…"`, or null when there is none. */
function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null;
  const match = /filename="([^"]+)"/.exec(header);
  if (match === null) return null;
  // The API already sanitises this to `[a-z0-9-]` plus the extension; stripping
  // path separators here as well means a header from anywhere cannot name a path.
  const cleaned = match[1]!.replace(/[/\\]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

type CsvState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; filename: string }
  | { kind: "error"; message: string };

/**
 * The member roster: who is in the community, on what package, and until when.
 *
 * THE ONE SCREEN IN THE DASHBOARD THAT SHOWS PERSONAL DATA (WhatsApp numbers, and
 * the CSV of them). Indonesia's UU PDP 27/2022 applies to it; nothing here is
 * logged, and the export is fetched with the bearer header rather than linked, so
 * no URL that would download it ever exists to be pasted or kept in history.
 */
export default function MembersPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [communityLoad] = useCommunity(communityId);

  if (communityLoad.kind === "loading") return <p className="muted">Memuat...</p>;
  if (communityLoad.kind === "error") return <ErrorPanel message={communityLoad.message} />;
  if (communityLoad.data === null) return <NotFoundPanel />;

  return (
    <section>
      <CommunityHeader community={communityLoad.data} />
      <h2>Anggota</h2>
      <Roster community={communityLoad.data} />
    </section>
  );
}

function Roster({ community }: { community: Community }) {
  const [load, handle] = useLoad(
    () => apiFetch<MemberRosterPage>(`/communities/${community.id}/members?limit=${PAGE_LIMIT}`),
    [community.id]
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  if (load.kind === "loading") return <p className="muted">Memuat anggota...</p>;
  if (load.kind === "error") {
    return <ErrorPanel message={load.message} onRetry={handle.reload} />;
  }

  const page = load.data;

  /**
   * The next page, by KEYSET rather than offset.
   *
   * The cursor anchors on the last row already shown, so rows arriving while a
   * creator reads cannot shift the window and make page two skip or repeat
   * somebody — which is exactly what an offset does on a list that grows.
   */
  async function loadMore() {
    if (page.nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await apiFetch<MemberRosterPage>(
        `/communities/${community.id}/members?limit=${PAGE_LIMIT}&before=${encodeURIComponent(
          page.nextCursor
        )}`
      );
      handle.update({
        members: [...page.members, ...next.members],
        nextCursor: next.nextCursor,
      });
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "gagal memuat halaman berikutnya");
    } finally {
      setLoadingMore(false);
    }
  }

  if (page.members.length === 0) {
    return (
      <EmptyState
        title="Belum ada anggota"
        action="Sebarkan tautan checkout komunitas ini (ada di tab “Ringkasan”) supaya orang bisa bergabung. Anggota yang membayar akan muncul di sini."
      />
    );
  }

  return (
    <div className="stack">
      <StatusLegend />
      <MemberTable community={community} members={page.members} />
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
      <CsvExport community={community} />
    </div>
  );
}

/**
 * What the three statuses mean, next to the table that uses them.
 *
 * `past_due` IS THE ONE THIS EXISTS FOR. A creator who reads "lewat jatuh tempo"
 * as "already locked out" goes and removes the member by hand during the grace
 * period the product built to keep them — so the legend says, in capitals, that
 * they still have access.
 */
function StatusLegend() {
  return (
    <div className="notice notice-info" data-testid="status-legend">
      <h3>Arti status</h3>
      <ul>
        {STATUSES.map((status) => (
          <li key={status}>
            <strong>{memberStatusLabel(status)}</strong> — {memberStatusExplanation(status)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MemberTable({ community, members }: { community: Community; members: MemberRow[] }) {
  /** The row awaiting confirmation, or null. Destructive, so nothing is sent
      until a second, deliberate press. */
  const [confirming, setConfirming] = useState<MemberRow | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * WHAT HAPPENED TO EACH MEMBER — one entry PER MEMBER, not one slot for the
   * screen.
   *
   * A single slot was a lie generator, and it is the exact lie this phase set out
   * to prevent: revoke somebody the provider could not remove, revoke somebody it
   * could, and the second outcome overwrote the first — so the only record that a
   * non-payer was still sitting in the paid group vanished the moment the creator
   * did their next piece of work. A map cannot do that.
   *
   * KEYED BY MEMBER ID rather than by row: a member holding two tiers has two
   * rows, and revocation is per community, so both rows are settled once either
   * one is.
   *
   * INSERTION ORDER IS RECENCY ORDER, maintained by deleting before setting (see
   * `confirmRevoke`), which is what lets `visibleOutcomes` take "the latest".
   */
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, RevokeOutcome>>(new Map());

  async function confirmRevoke(member: MemberRow) {
    setBusy(true);
    try {
      const outcome = await revokeMember(community.id, member);
      setOutcomes((previous) => {
        const next = new Map(previous);
        // Delete first: `Map.set` on an existing key keeps the ORIGINAL insertion
        // position, so re-revoking a member after a failure would otherwise leave
        // a stale entry looking like the most recent action.
        next.delete(member.memberId);
        next.set(member.memberId, outcome);
        return next;
      });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  /** Forgets one member's outcome, so a retry starts from a clean panel. */
  function clearOutcome(memberId: string) {
    setOutcomes((previous) => {
      if (!previous.has(memberId)) return previous;
      const next = new Map(previous);
      next.delete(memberId);
      return next;
    });
  }

  return (
    <>
      {confirming !== null ? (
        <div className="notice notice-warning" data-testid="revoke-confirm" role="alertdialog">
          <h3>Cabut akses {memberLabel(confirming)}?</h3>
          <p>
            Mereka akan dikeluarkan dari grup berbayar komunitas ini dan tautan undangan mereka
            dimatikan. Tindakan ini tidak bisa dibatalkan dari dasbor — untuk memasukkan mereka
            kembali, undang mereka lagi secara manual.
          </p>
          <div className="row">
            <button
              type="button"
              className="button-danger"
              onClick={() => confirmRevoke(confirming)}
              disabled={busy}
            >
              Ya, cabut akses
            </button>
            <button
              type="button"
              className="button-quiet"
              onClick={() => setConfirming(null)}
              disabled={busy}
            >
              Batal
            </button>
          </div>
        </div>
      ) : null}

      {visibleOutcomes(outcomes).map((outcome) => (
        <RevokeResultPanel key={outcomeKey(outcome)} outcome={outcome} />
      ))}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Nama</th>
              <th>WhatsApp</th>
              <th>Paket</th>
              <th>Status</th>
              <th>Bergabung</th>
              <th>Tagihan berikutnya</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const outcome = outcomes.get(member.memberId);
              return (
              <tr key={member.subscriptionId}>
                <td>{member.name ?? "(tanpa nama)"}</td>
                <td>{member.whatsappNumber}</td>
                <td>{member.tierName}</td>
                <td>
                  <span className={`badge badge-${member.status.replace(/_/g, "-")}`}>
                    {memberStatusLabel(member.status)}
                  </span>
                </td>
                <td>{formatDateTime(member.joinedAt)}</td>
                <td>{member.nextBillingDate === null ? "—" : formatDate(member.nextBillingDate)}</td>
                <td>
                  {outcome !== undefined && outcome.kind !== "failed" ? (
                    <RevokeOutcomeCell outcome={outcome} />
                  ) : REVOCABLE.has(member.status) ? (
                    <button
                      type="button"
                      className="button-danger"
                      onClick={() => {
                        clearOutcome(member.memberId);
                        setConfirming(member);
                      }}
                      disabled={busy || confirming !== null}
                    >
                      Cabut akses
                    </button>
                  ) : null}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function memberLabel(member: MemberRow): string {
  return member.name ?? member.whatsappNumber;
}

type RevokeOutcome =
  | { kind: "automated"; member: MemberRow; result: RevokeResult }
  | { kind: "manual"; member: MemberRow; result: RevokeResult }
  | { kind: "no_access"; member: MemberRow }
  | { kind: "failed"; member: MemberRow; message: string };

/** An outcome the row can render — every kind except the one that keeps the button. */
type SettledOutcome = Exclude<RevokeOutcome, { kind: "failed" }>;

/** React key, and the member each panel is about. Stable across re-renders. */
function outcomeKey(outcome: RevokeOutcome): string {
  return outcome.member.memberId;
}

/**
 * WHICH OUTCOME PANELS STAY ON SCREEN — every unresolved one, plus the latest.
 *
 * A `manual` outcome is not a notification, it is an OUTSTANDING TASK: a member
 * who no longer pays is inside the creator's paid group and only the creator can
 * remove them. Nothing this screen can observe resolves it, so it stays until the
 * page is reloaded — however many other members are revoked afterwards.
 *
 * The other three describe a finished action and are also written into the
 * member's own row, so only the most recent is kept; otherwise a creator tidying
 * up twenty lapsed members would end up reading twenty stacked confirmations to
 * find the one warning that mattered.
 */
function visibleOutcomes(outcomes: ReadonlyMap<string, RevokeOutcome>): RevokeOutcome[] {
  const all = [...outcomes.values()];
  const unresolved = all.filter((outcome) => outcome.kind === "manual");
  const latest = all[all.length - 1];
  return latest !== undefined && latest.kind !== "manual" ? [...unresolved, latest] : unresolved;
}

/**
 * WHAT A REVOKED MEMBER'S ROW SAYS, which is NOT the same sentence for every
 * outcome.
 *
 * The row is what a creator reads after the panel has scrolled away, so a `manual`
 * revocation that rendered as "Akses grup dicabut" told them the member was out of
 * the group when they were still in it — the same lie as the overwritten panel,
 * one line further down. Each kind gets its own words, and only the automated one
 * is allowed to claim the group membership ended.
 */
function RevokeOutcomeCell({ outcome }: { outcome: SettledOutcome }) {
  if (outcome.kind === "manual") {
    return (
      <span className="cell-warning">Dicabut di catatan — BELUM keluar dari grup</span>
    );
  }
  if (outcome.kind === "no_access") {
    return <span className="muted">Tidak ada akses aktif</span>;
  }
  return <span className="muted">Akses grup dicabut</span>;
}

/**
 * `POST /communities/:id/members/:memberId/revoke`, classified honestly.
 *
 * `automated: false` IS NOT AN ERROR AND IT IS NOT A SUCCESS. It is a 200 saying
 * "we withdrew the entitlement in our records and could not remove them at the
 * provider", which means a person who no longer pays is still sitting in the paid
 * group. It gets its own outcome so the panel below cannot render it with the
 * success wording by accident.
 */
async function revokeMember(communityId: string, member: MemberRow): Promise<RevokeOutcome> {
  try {
    const result = await apiFetch<RevokeResult>(
      `/communities/${communityId}/members/${member.memberId}/revoke`,
      { method: "POST" }
    );
    return { kind: result.automated ? "automated" : "manual", member, result };
  } catch (err) {
    if (err instanceof DashboardApiError && err.status === 404) {
      return { kind: "no_access", member };
    }
    return {
      kind: "failed",
      member,
      message: err instanceof Error ? err.message : "gagal mencabut akses",
    };
  }
}

/**
 * WHAT ACTUALLY HAPPENED, which is not always what was asked for.
 *
 * The worst thing this screen could do is tell a creator a member was removed when
 * they are still in the group, so the three outcomes have three different panels
 * and only one of them says the removal happened.
 *
 * EVERY PANEL NAMES ITS MEMBER, including the failure one. More than one of these
 * can be on screen at once now (see `visibleOutcomes`), and an unattributed
 * "akses belum tentu tercabut" sitting above a warning about somebody else is
 * worse than no panel at all.
 */
function RevokeResultPanel({ outcome }: { outcome: RevokeOutcome }) {
  if (outcome.kind === "failed") {
    return (
      <p className="form-error" data-testid="revoke-result" role="alert">
        {memberLabel(outcome.member)}: {outcome.message} — akses belum tentu tercabut. Muat ulang
        halaman ini dan periksa lagi.
      </p>
    );
  }

  if (outcome.kind === "no_access") {
    return (
      <div className="notice notice-info" data-testid="revoke-result" role="status">
        <h3>Tidak ada yang perlu dicabut</h3>
        <p>
          {memberLabel(outcome.member)} tidak punya akses aktif ke komunitas ini — mungkin sudah
          dicabut sebelumnya, atau akses mereka sudah berakhir. Muat ulang halaman untuk melihat
          daftar terbaru.
        </p>
      </div>
    );
  }

  if (outcome.kind === "manual") {
    return (
      <div className="notice notice-warning" data-testid="revoke-result" role="alert">
        <h3>PERLU TINDAKAN: {memberLabel(outcome.member)} BELUM dikeluarkan dari grup</h3>
        <p>
          Hak akses mereka sudah dicabut di catatan DIUDARA, tetapi kami tidak bisa mengeluarkan
          mereka dari grup secara otomatis. Selama Anda tidak mengeluarkannya sendiri secara manual,
          mereka masih berada di dalam grup berbayar Anda.
        </p>
        <ul>
          {outcome.result.channels
            .filter((channel) => !channel.automated)
            .map((channel) => (
              <li key={channel.channelId}>
                <strong>{platformLabel(channel.platform)}</strong>:{" "}
                {(channel.reason !== undefined
                  ? REVOKE_FAILURE_REASONS[channel.reason]
                  : undefined) ??
                  "Keluarkan anggota ini dari grup tersebut secara manual."}
              </li>
            ))}
        </ul>
        <p>{SUBSCRIPTION_UNCHANGED}</p>
      </div>
    );
  }

  return (
    <div className="notice notice-info" data-testid="revoke-result" role="status">
      <h3>Akses dicabut</h3>
      <p>
        {memberLabel(outcome.member)} sudah dikeluarkan dari grup secara otomatis (
        {outcome.result.revoked} grup).
      </p>
      <p>{SUBSCRIPTION_UNCHANGED}</p>
    </div>
  );
}

/**
 * SAID ON BOTH OUTCOMES, because it is true on both and it surprises people.
 *
 * `RevokeChannelAccess` revokes CHANNEL MEMBERSHIPS. It does not touch
 * `subscription.status`, and the API has no endpoint that does — so a creator who
 * reads "akses dicabut" as "this member is cancelled" would be wrong, and would
 * find the row still saying "Aktif" after a reload. Flagged in the task report as
 * a gap rather than papered over here.
 */
const SUBSCRIPTION_UNCHANGED =
  "Catatan: status langganan anggota ini tidak ikut berubah — mencabut akses grup tidak menghentikan langganan atau penagihannya.";

/**
 * The roster as a CSV, FETCHED rather than linked.
 *
 * A plain `<a href="…/members.csv">` sends no `Authorization` header, so it would
 * download the API's 401 as a file — and a URL that authenticated itself instead
 * would be a bearer credential for every member's phone number, which is why the
 * endpoint deliberately has no signed-link shortcut. So the bytes come back through
 * the same authenticated client as everything else and are handed to the browser as
 * a blob.
 */
function CsvExport({ community }: { community: Community }) {
  const [state, setState] = useState<CsvState>({ kind: "idle" });

  async function download() {
    setState({ kind: "working" });
    try {
      const res = await apiRequest(`/communities/${community.id}/members.csv`);
      if (!res.ok) {
        setState({ kind: "error", message: `Gagal mengunduh CSV (${res.status}).` });
        return;
      }
      const blob = await res.blob();
      const filename =
        filenameFromDisposition(res.headers.get("Content-Disposition")) ??
        `anggota-${community.slug}.csv`;

      if (typeof URL.createObjectURL !== "function") {
        setState({
          kind: "error",
          message: "Peramban ini tidak mendukung unduhan otomatis. Coba peramban lain.",
        });
        return;
      }
      const href = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        // Released immediately: the blob holds every member's phone number in
        // memory, and an object URL keeps it alive for the life of the document.
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(href);
      }
      setState({ kind: "done", filename });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "gagal mengunduh CSV",
      });
    }
  }

  return (
    <div className="card stack">
      <div>
        <h3>Ekspor daftar anggota</h3>
        <p className="hint" data-testid="csv-note">
          Berkas CSV ini berisi nama dan nomor WhatsApp anggota — data pribadi. Simpan di tempat
          aman dan jangan bagikan ke pihak lain.
        </p>
      </div>
      <div>
        <button
          type="button"
          className="button-secondary"
          onClick={download}
          disabled={state.kind === "working"}
        >
          {state.kind === "working" ? "Menyiapkan..." : "Unduh CSV"}
        </button>
      </div>
      {state.kind === "done" ? <p className="form-ok">Berkas {state.filename} diunduh.</p> : null}
      {state.kind === "error" ? (
        <p className="form-error" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
