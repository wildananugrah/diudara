import {
  CSV_BOM,
  CSV_LINE_TERMINATOR,
  csvAttachmentFilename,
  memberCsvHeaderLine,
  memberCsvLine,
} from "../../domain/member-csv";
import { NotFoundError } from "../errors";
import { redactLinks, safeErrorSummary, safeLabel } from "../log-safety";
import type { AnalyticsRepositoryPort } from "../ports/analytics-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";

/**
 * Rows fetched per database round trip while streaming the export.
 *
 * Exported so the test can prove the export actually PAGES, without seeding an
 * arbitrary number of members and hoping.
 *
 * 500 is a compromise, not a magic number: small enough that one page is a trivial
 * amount of memory, large enough that a 10 000-member roster is 20 round trips rather
 * than 10 000. The keyset makes any size correct; only the cost changes.
 */
export const MEMBER_EXPORT_PAGE_SIZE = 500;

export interface MemberExport {
  /** UTF-8 CSV bytes. Consume once. */
  body: ReadableStream<Uint8Array>;
  /** For `Content-Disposition: attachment`. Includes the community slug. */
  filename: string;
}

/**
 * The member roster as a downloadable CSV.
 *
 * STREAMED, NOT BUFFERED, and that is a memory decision rather than a style one. One
 * `select` with no limit over a successful creator's roster is read entirely into this
 * process, then formatted into one large string, and both live there until the
 * response finishes — twice the roster in memory, per concurrent export. Instead this
 * reads `MEMBER_EXPORT_PAGE_SIZE` rows at a time through the same keyset the roster
 * screen uses and writes each page out as it arrives, so peak memory is one page
 * regardless of how big the community gets.
 *
 * OWNERSHIP IS CHECKED FIRST, BEFORE A SINGLE ROSTER ROW IS READ. It has to be: a
 * stream cannot be un-sent, so an ownership check discovered halfway through would
 * mean a stranger had already received part of somebody else's members' phone
 * numbers with a 200 status on it. `findByIdForCreator` is the existing scoped read
 * (`CommunityRepositoryPort` has no unscoped `findById`), and its result is also where
 * the filename's slug comes from — so the two things that need the community are one
 * query.
 *
 * NO ROW EVER REACHES A LOG. The rows carry WhatsApp numbers, and a log line reaches
 * an aggregator, is retained, and is read by people who are not the creator. There is
 * no diagnostic worth that. The ONE thing that is logged is a failure of the stream
 * itself, ids-and-reason only, through the same `redactLinks(safeErrorSummary(...))`
 * pairing the rest of the codebase uses — see `streamCsv` for why silence there is
 * not an option.
 */
export class ExportCommunityMembers {
  constructor(
    private readonly communities: CommunityRepositoryPort,
    private readonly analytics: AnalyticsRepositoryPort
  ) {}

  async execute(input: { communityId: string; creatorId: string }): Promise<MemberExport> {
    const community = await this.communities.findByIdForCreator(
      input.communityId,
      input.creatorId
    );
    if (!community) {
      // 404 and no file at all — not an empty one, and not a header-only one that
      // would confirm the community exists.
      throw new NotFoundError("community not found");
    }

    return {
      body: this.streamCsv(input.communityId, input.creatorId),
      filename: csvAttachmentFilename(community.slug),
    };
  }

  private streamCsv(communityId: string, creatorId: string): ReadableStream<Uint8Array> {
    const analytics = this.analytics;
    const encoder = new TextEncoder();
    // `pull`-based rather than `start`-based: the consumer's backpressure then
    // controls when the next page is queried, so a slow client cannot make this
    // process race ahead and buffer the whole roster anyway.
    let cursor: { timestamp: Date; id: string } | undefined;
    let finished = false;
    let wroteHeader = false;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (finished) {
          controller.close();
          return;
        }

        const parts: string[] = [];
        if (!wroteHeader) {
          // The BOM first, then the header. Excel on Windows needs the BOM to read
          // the file as UTF-8 — see CSV_BOM.
          parts.push(CSV_BOM, memberCsvHeaderLine());
          wroteHeader = true;
        }

        let rows;
        try {
          rows = await analytics.listMembersForCreator(communityId, creatorId, {
            limit: MEMBER_EXPORT_PAGE_SIZE,
            ...(cursor === undefined ? {} : { before: cursor }),
          });
        } catch (err) {
          // THE ONLY PLACE THIS FILE LOGS, and it has to.
          //
          // The status line and `Content-Disposition` went out with the first chunk,
          // so a failure here CANNOT become a 500 — the response simply stops. A
          // browser shows a failed download, but `curl -o roster.csv` writes a file
          // that opens, parses, and is quietly missing members. Rethrowing errors the
          // stream, which aborts the transfer rather than ending it cleanly (that is
          // the only truncation signal available on the wire once a 200 has been
          // sent) — but nothing would have recorded, anywhere, that a creator's
          // export was cut short. Now something does.
          //
          // IDS AND THE REASON ONLY. `safeErrorSummary` walks the cause chain and
          // drops the bound parameters — which for THIS query are members' WhatsApp
          // numbers — and `redactLinks` covers a provider or driver message that
          // interpolated a URL. Never a row, never the roster's size.
          console.error(
            `[export] the member CSV export failed mid-stream: community=${safeLabel(
              communityId
            )} — the response has already been sent with a 200, so the creator has a ` +
              "TRUNCATED roster file. The transfer is aborted rather than closed: " +
              redactLinks(safeErrorSummary(err))
          );
          throw err;
        }

        // `null` here would mean the community stopped being the creator's between
        // the ownership check and this read. Ending the stream is the only honest
        // option — the status line has already gone out — and it cannot leak, because
        // `null` carries no rows.
        if (rows === null || rows.length === 0) {
          finished = true;
        } else {
          for (const row of rows) {
            parts.push(CSV_LINE_TERMINATOR, memberCsvLine(row));
          }
          const last = rows[rows.length - 1]!;
          cursor = { timestamp: last.joinedAt, id: last.subscriptionId };
          // A SHORT PAGE MEANS THE END. Without this the export would spend one extra
          // round trip per download discovering an empty page, and a bug in the
          // condition would hold the response open for ever.
          if (rows.length < MEMBER_EXPORT_PAGE_SIZE) finished = true;
        }

        if (parts.length > 0) {
          controller.enqueue(encoder.encode(parts.join("")));
        }
        if (finished) {
          controller.close();
        }
      },
    });
  }
}
