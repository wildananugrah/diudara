import { describe, expect, it } from "bun:test";
import { NotFoundError } from "../errors";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type {
  AnalyticsRepositoryPort,
  MemberRosterRow,
} from "../ports/analytics-repository.port";
import {
  ExportCommunityMembers,
  MEMBER_EXPORT_PAGE_SIZE,
} from "./export-community-members";

const COMMUNITY: CommunityRecord = {
  id: "3f1c9e0a-1111-4222-8333-444455556666",
  creatorId: "aaaaaaaa-1111-4222-8333-444455556666",
  name: "Kelas Budi",
  slug: "kelas-budi",
  niche: null,
  status: "active",
  accessMode: "paid",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function communities(record: CommunityRecord | null): CommunityRepositoryPort {
  return {
    async create() {
      throw new Error("not used");
    },
    async findByIdForCreator(id, creatorId) {
      // Scoped, exactly as the real repository is — so a stranger's id gets null.
      return record !== null && record.id === id && record.creatorId === creatorId ? record : null;
    },
    async listByCreator() {
      return [];
    },
    async slugExists() {
      return false;
    },
    async update() {
      return null;
    },
    async findBySlug() {
      return null;
    },
  };
}

function rosterRow(index: number): MemberRosterRow {
  return {
    memberId: `member-${index}`,
    subscriptionId: `subscription-${index}`,
    name: `Member ${index}`,
    whatsappNumber: `+628100000${String(index).padStart(4, "0")}`,
    tierName: "Basic",
    status: "active",
    // Descending, so the fake behaves like the keyset query: each page's last row is
    // older than the next page's first.
    joinedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - index * 1000),
    nextBillingDate: "2026-09-01",
  };
}

/**
 * An analytics repository holding `total` roster rows, which records every page it
 * was asked for. The recording is the point: it is the only way to prove the export
 * READS IN PAGES rather than pulling the whole roster into memory and formatting it.
 */
function analyticsWith(total: number, options: { owned?: boolean } = {}) {
  const rows = Array.from({ length: total }, (_, index) => rosterRow(index));
  const requests: { limit: number; before?: { timestamp: Date; id: string } }[] = [];

  const repository: AnalyticsRepositoryPort = {
    async getMetricsForCreator() {
      return null;
    },
    async listActivityForCreator() {
      return null;
    },
    async listMembersForCreator(_communityId, _creatorId, page) {
      if (options.owned === false) return null;
      requests.push(page);
      const start =
        page.before === undefined
          ? 0
          : rows.findIndex((row) => row.subscriptionId === page.before!.id) + 1;
      return rows.slice(start, start + page.limit);
    },
  };

  return { repository, requests, rows };
}

/** Drains the export's stream into one string. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("ExportCommunityMembers", () => {
  it("reads the roster in PAGES rather than buffering it whole", async () => {
    // The reason this matters is memory, and it is not hypothetical at the scale this
    // product is for: one `select` with no limit over a successful creator's roster is
    // read entirely into the API process before a single byte reaches the browser, and
    // it stays there until the response finishes.
    const total = MEMBER_EXPORT_PAGE_SIZE * 2 + 7;
    const { repository, requests } = analyticsWith(total);
    const useCase = new ExportCommunityMembers(communities(COMMUNITY), repository);

    const exported = await useCase.execute({
      communityId: COMMUNITY.id,
      creatorId: COMMUNITY.creatorId,
    });
    const body = await drain(exported.body);

    // Three full pages plus the short one that ends the stream.
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const request of requests) {
      expect(request.limit).toBe(MEMBER_EXPORT_PAGE_SIZE);
    }
    // The first page has no cursor; every later one does, and it advances.
    expect(requests[0]!.before).toBeUndefined();
    expect(requests[1]!.before).not.toBeUndefined();

    // And every member is in the file exactly once — one header plus `total` records.
    const records = body.replace(/^﻿/, "").split("\r\n");
    expect(records).toHaveLength(total + 1);
    expect(new Set(records).size).toBe(records.length);
  });

  it("stops asking for pages once a short page comes back", async () => {
    // A page shorter than the limit means the end of the roster. Asking again would
    // cost one pointless round trip per export, and a bug that never stops would loop
    // for ever holding the response open.
    const { repository, requests } = analyticsWith(3);
    const useCase = new ExportCommunityMembers(communities(COMMUNITY), repository);
    const exported = await useCase.execute({
      communityId: COMMUNITY.id,
      creatorId: COMMUNITY.creatorId,
    });
    await drain(exported.body);

    expect(requests).toHaveLength(1);
  });

  it("names the file after the community slug", async () => {
    const { repository } = analyticsWith(1);
    const useCase = new ExportCommunityMembers(communities(COMMUNITY), repository);
    const exported = await useCase.execute({
      communityId: COMMUNITY.id,
      creatorId: COMMUNITY.creatorId,
    });
    await drain(exported.body);

    expect(exported.filename).toContain("kelas-budi");
    expect(exported.filename.endsWith(".csv")).toBe(true);
  });

  it("throws NotFoundError for a community the caller does not own, before any roster read", async () => {
    // BEFORE, not after: a stranger must not cause a single row of somebody else's
    // roster to be read, let alone streamed.
    const { repository, requests } = analyticsWith(5);
    const useCase = new ExportCommunityMembers(communities(COMMUNITY), repository);

    await expect(
      useCase.execute({ communityId: COMMUNITY.id, creatorId: "somebody-else" })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(requests).toEqual([]);
  });

  it("LOGS a mid-stream failure instead of truncating the roster in silence", async () => {
    // THE SHAPE OF THE BUG. The status line and `Content-Disposition` have already
    // gone out by the time page two is read, so a database error here cannot become
    // a 500 — the response just stops. A browser shows a failed download, but
    // `curl -o roster.csv` writes a file that opens, parses, and is missing members,
    // with nothing anywhere saying so. The stream must fail loudly on our side even
    // though it cannot change its own status code.
    const { repository } = analyticsWith(MEMBER_EXPORT_PAGE_SIZE * 2);
    const readPage = repository.listMembersForCreator.bind(repository);
    let pages = 0;
    repository.listMembersForCreator = async (communityId, creatorId, page) => {
      if (pages++ === 1) {
        // Drizzle's shape: the statement in `message`, the bound values behind
        // `params:` — which is where a member's WhatsApp number would be.
        throw new Error(
          'Failed query: select … from "member"\nparams: +6281234567890,kelas-budi'
        );
      }
      return readPage(communityId, creatorId, page);
    };

    const useCase = new ExportCommunityMembers(communities(COMMUNITY), repository);
    const exported = await useCase.execute({
      communityId: COMMUNITY.id,
      creatorId: COMMUNITY.creatorId,
    });

    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      // The consumer must SEE the failure. A stream that closed cleanly here is the
      // silent partial roster.
      await expect(drain(exported.body)).rejects.toThrow();
    } finally {
      console.error = original;
    }

    const line = logged.find((entry) => entry.includes("export"));
    expect(line).toBeDefined();
    // Diagnosable: which community, and what went wrong.
    expect(line).toContain(COMMUNITY.id);
    expect(line).toContain("Failed query");
    // NOT AT THE COST OF THE THING THIS ENDPOINT EXISTS TO PROTECT. The roster is
    // members' phone numbers; a log line reaches an aggregator and is read by people
    // who are not the creator.
    expect(line).not.toContain("+6281234567890");
    expect(line).not.toContain("params:");
  });

  it("emits a header even when the roster is empty", async () => {
    const { repository } = analyticsWith(0);
    const useCase = new ExportCommunityMembers(communities(COMMUNITY), repository);
    const exported = await useCase.execute({
      communityId: COMMUNITY.id,
      creatorId: COMMUNITY.creatorId,
    });

    const body = await drain(exported.body);
    expect(body.replace(/^﻿/, "").split("\r\n")).toHaveLength(1);
  });
});
