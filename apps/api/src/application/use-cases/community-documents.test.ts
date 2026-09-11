import { describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type { DocumentRepositoryPort, DocumentRow } from "../ports/document-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";
import type { ClockPort } from "../ports/clock.port";
import { FakeDocumentStorageAdapter } from "../../infrastructure/storage/fake-document-storage.adapter";
import {
  DeleteCommunityDocument,
  DownloadCommunityDocument,
  ListCommunityDocuments,
  UploadCommunityDocument,
} from "./community-documents";

const COMMUNITY_ID = "cccccccc-0000-4000-8000-000000000000";
const OWNER_ID = "00000000-0000-4000-8000-000000000000";
const MEMBER_ID = "11111111-0000-4000-8000-000000000000";
const STRANGER_ID = "22222222-0000-4000-8000-000000000000";

function community(): CommunityRecord {
  return {
    id: COMMUNITY_ID,
    ownerId: OWNER_ID,
    slug: "kelas-fisika",
    name: "Kelas Fisika",
    category: "Akademik",
    description: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

class FakeCommunities implements CommunityRepositoryPort {
  members = new Set<string>([OWNER_ID, MEMBER_ID]);
  constructor(private readonly rows: CommunityRecord[]) {}
  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return this.rows.find((row) => row.slug === slug) ?? null;
  }
  async isMember(_communityId: string, userId: string): Promise<boolean> {
    return this.members.has(userId);
  }
  private unused(): never {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<never> {
    return this.unused();
  }
  async create(): Promise<never> {
    return this.unused();
  }
  async browse(): Promise<never> {
    return this.unused();
  }
  async memberCountFor(): Promise<never> {
    return this.unused();
  }
  async join(): Promise<never> {
    return this.unused();
  }
  async leave(): Promise<never> {
    return this.unused();
  }
  async listMembers(): Promise<never> {
    return this.unused();
  }
}

class FakeDocuments implements DocumentRepositoryPort {
  rows: DocumentRow[] = [];
  deleted: string[] = [];

  async create(input: {
    id: string;
    communityId: string;
    uploaderId: string;
    name: string;
    contentType: string;
    byteSize: number;
    membersOnly?: boolean;
  }): Promise<DocumentRow> {
    const row: DocumentRow = {
      id: input.id,
      communityId: input.communityId,
      name: input.name,
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
      membersOnly: input.membersOnly ?? false,
      uploaderHandle: "wildan",
      uploaderDisplayName: "Wildan",
    };
    this.rows.push(row);
    return row;
  }
  async listByCommunity(communityId: string): Promise<DocumentRow[]> {
    return this.rows.filter((row) => row.communityId === communityId);
  }
  async findById(id: string): Promise<DocumentRow | null> {
    if (this.deleted.includes(id)) return null;
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async softDelete(id: string): Promise<void> {
    this.deleted.push(id);
  }
}

/**
 * Holds subscriptions BY COMMUNITY, and deliberately exposes a personal one
 * too — the conflation tests need an owner who sells both.
 */
class FakeSubscriptions implements Partial<UserSubscriptionRepositoryPort> {
  communityRows = new Map<string, UserSubscriptionRow>();

  async findActiveForCommunity(
    subscriberId: string,
    communityId: string
  ): Promise<UserSubscriptionRow | null> {
    return this.communityRows.get(`${subscriberId}:${communityId}`) ?? null;
  }

  grant(subscriberId: string, communityId: string, currentPeriodEnd: Date | null): void {
    this.communityRows.set(`${subscriberId}:${communityId}`, {
      id: "sub-1",
      subscriberId,
      tierId: "tier-1",
      ownerId: OWNER_ID,
      status: "active",
      kind: "paid",
      currentPeriodEnd,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      communityId,
    });
  }
}

/** A failing repository, for the compensating-delete test. */
class ExplodingDocuments extends FakeDocuments {
  override async create(): Promise<DocumentRow> {
    throw new Error("database is on fire");
  }
}

const NOW = new Date("2026-09-11T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

function subject(documents: DocumentRepositoryPort = new FakeDocuments()) {
  const communities = new FakeCommunities([community()]);
  const storage = new FakeDocumentStorageAdapter();
  const subscriptions = new FakeSubscriptions() as unknown as UserSubscriptionRepositoryPort;
  const clock: ClockPort = { now: () => NOW };
  return {
    communities,
    documents: documents as FakeDocuments,
    storage,
    subscriptions: subscriptions as unknown as FakeSubscriptions,
    upload: new UploadCommunityDocument(communities, documents, storage),
    list: new ListCommunityDocuments(communities, documents, subscriptions, clock),
    download: new DownloadCommunityDocument(communities, documents, storage, subscriptions, clock),
    remove: new DeleteCommunityDocument(communities, documents, storage),
  };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function anUpload(overrides: Partial<Parameters<UploadCommunityDocument["execute"]>[0]> = {}) {
  return {
    slug: "kelas-fisika",
    uploaderId: OWNER_ID,
    name: "Rangkuman.pdf",
    contentType: "application/pdf",
    bytes: PDF,
    ...overrides,
  };
}

describe("UploadCommunityDocument", () => {
  test("the owner uploads, and the bytes land under the row's id", async () => {
    const s = subject();

    const view = await s.upload.execute(anUpload());

    expect(view.name).toBe("Rangkuman.pdf");
    expect(view.byteSize).toBe(PDF.byteLength);
    expect(await s.storage.get(view.id)).toEqual(PDF);
  });

  test("byteSize is MEASURED, never taken from a caller", async () => {
    const s = subject();
    const bigger = new Uint8Array(1024);

    const view = await s.upload.execute(anUpload({ bytes: bigger }));

    expect(view.byteSize).toBe(1024);
  });

  test("a member who is not the owner may not upload, and nothing is written", async () => {
    const s = subject();

    await expect(s.upload.execute(anUpload({ uploaderId: MEMBER_ID }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(s.documents.rows).toEqual([]);
    expect(s.storage.size).toBe(0);
  });

  test("a stranger may not upload either", async () => {
    const s = subject();
    await expect(s.upload.execute(anUpload({ uploaderId: STRANGER_ID }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
  });

  test("an unknown slug is NotFound, checked before the owner rule", async () => {
    const s = subject();
    await expect(s.upload.execute(anUpload({ slug: "tidak-ada" }))).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(s.storage.size).toBe(0);
  });

  /**
   * The no-orphan rule, asserted against the STORAGE rather than the response
   * status. An upload that 400s after writing bytes leaves something nothing
   * will ever collect — there is no sweep over this table the way there is
   * over unclaimed `post_media`.
   */
  test.each([
    ["an unsupported type", { contentType: "text/html" }],
    ["a type of nothing at all", { contentType: "" }],
    ["a name that sanitises to nothing", { name: "../.." }],
    ["bytes over the cap", { bytes: new Uint8Array(25 * 1024 * 1024 + 1) }],
  ])("%s is refused with no row and no bytes", async (_label, overrides) => {
    const s = subject();

    await expect(s.upload.execute(anUpload(overrides))).rejects.toBeInstanceOf(Error);

    expect(s.documents.rows).toEqual([]);
    expect(s.storage.size).toBe(0);
  });

  test("a refusal carries the wire code the client branches on", async () => {
    const s = subject();
    try {
      await s.upload.execute(anUpload({ contentType: "application/zip" }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ValidationError).code).toBe("document_unsupported_format");
    }
  });

  test("the stored name is the SANITISED one, not what the client sent", async () => {
    const s = subject();

    const view = await s.upload.execute(anUpload({ name: "../../etc/passwd" }));

    expect(view.name).toBe("etcpasswd");
  });

  /**
   * Bytes are written before the row, so the row always implies bytes exist.
   * When the row write then fails, the bytes must be taken back — otherwise
   * every failed insert leaves an object nobody can reach or collect.
   */
  test("a failed row write takes the bytes back out of storage", async () => {
    const s = subject(new ExplodingDocuments());

    await expect(s.upload.execute(anUpload())).rejects.toThrow("database is on fire");

    expect(s.storage.size).toBe(0);
  });
});

describe("ListCommunityDocuments", () => {
  test("is open — a stranger and a signed-out visitor both get the list", async () => {
    const s = subject();
    await s.upload.execute(anUpload());

    for (const viewerId of [STRANGER_ID, null]) {
      const { documents } = await s.list.execute({ slug: "kelas-fisika", viewerId });
      expect(documents.map((d) => d.name)).toEqual(["Rangkuman.pdf"]);
    }
  });

  test("says PER DOCUMENT whether this viewer may download, so no dead control is rendered", async () => {
    const s = subject();
    await s.upload.execute(anUpload());

    const asMember = await s.list.execute({ slug: "kelas-fisika", viewerId: MEMBER_ID });
    const asStranger = await s.list.execute({ slug: "kelas-fisika", viewerId: STRANGER_ID });
    const signedOut = await s.list.execute({ slug: "kelas-fisika", viewerId: null });

    expect(asMember.documents[0]!.mayDownload).toBe(true);
    expect(asStranger.documents[0]!.mayDownload).toBe(false);
    expect(signedOut.documents[0]!.mayDownload).toBe(false);
  });

  test("the view is CLOSED, and carries no URL", async () => {
    const s = subject();
    await s.upload.execute(anUpload());

    const { documents } = await s.list.execute({ slug: "kelas-fisika", viewerId: null });

    expect(Object.keys(documents[0]!).sort()).toEqual([
      "byteSize",
      "contentType",
      "createdAt",
      "id",
      "mayDownload",
      "membersOnly",
      "name",
      "uploader",
    ]);
  });

  test("an unknown slug is NotFound", async () => {
    const s = subject();
    await expect(
      s.list.execute({ slug: "tidak-ada", viewerId: null })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DownloadCommunityDocument", () => {
  async function uploaded() {
    const s = subject();
    const view = await s.upload.execute(anUpload());
    return { s, id: view.id };
  }

  test("a member gets the bytes, the type and the name", async () => {
    const { s, id } = await uploaded();

    const result = await s.download.execute({ slug: "kelas-fisika", id, viewerId: MEMBER_ID });

    expect(result.bytes).toEqual(PDF);
    expect(result.contentType).toBe("application/pdf");
    expect(result.name).toBe("Rangkuman.pdf");
  });

  test("the owner gets them too — owning is not a separate rule here", async () => {
    const { s, id } = await uploaded();
    const result = await s.download.execute({ slug: "kelas-fisika", id, viewerId: OWNER_ID });
    expect(result.bytes).toEqual(PDF);
  });

  /**
   * Refused as NOT FOUND, never Forbidden. A 403 confirms the document exists
   * to somebody who may not have it, and 404 is what an absent document
   * already answers — so gated and absent look identical from outside.
   */
  test.each([
    ["a signed-in non-member", STRANGER_ID],
    ["a signed-out visitor", null],
  ])("%s is refused as NotFound, not Forbidden", async (_label, viewerId) => {
    const { s, id } = await uploaded();

    const attempt = s.download.execute({ slug: "kelas-fisika", id, viewerId });

    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenError);
  });

  /**
   * The document belongs to a community; the URL names one. A document
   * reachable through ANY community's slug would let a member of community A
   * read community B's library.
   */
  test("a document from another community is NotFound under this slug", async () => {
    const { s, id } = await uploaded();
    s.documents.rows[0]!.communityId = "dddddddd-0000-4000-8000-000000000000";

    await expect(
      s.download.execute({ slug: "kelas-fisika", id, viewerId: MEMBER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a row whose bytes are missing is NotFound, not a crash", async () => {
    const { s, id } = await uploaded();
    await s.storage.remove(id);

    await expect(
      s.download.execute({ slug: "kelas-fisika", id, viewerId: MEMBER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("an unknown id is NotFound", async () => {
    const { s } = await uploaded();
    await expect(
      s.download.execute({ slug: "kelas-fisika", id: "nope", viewerId: MEMBER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DeleteCommunityDocument", () => {
  async function uploaded() {
    const s = subject();
    const view = await s.upload.execute(anUpload());
    return { s, id: view.id };
  }

  test("the owner deletes the row AND the bytes", async () => {
    const { s, id } = await uploaded();

    await s.remove.execute({ slug: "kelas-fisika", id, viewerId: OWNER_ID });

    expect(s.documents.deleted).toEqual([id]);
    // Unlike a post's images, which are deliberately retained, a document has
    // one referent and nothing else that might still want it.
    expect(s.storage.size).toBe(0);
  });

  test("a member may not delete, and nothing is removed", async () => {
    const { s, id } = await uploaded();

    await expect(
      s.remove.execute({ slug: "kelas-fisika", id, viewerId: MEMBER_ID })
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(s.documents.deleted).toEqual([]);
    expect(s.storage.size).toBe(1);
  });

  test("an unknown id is NotFound", async () => {
    const { s } = await uploaded();
    await expect(
      s.remove.execute({ slug: "kelas-fisika", id: "nope", viewerId: OWNER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a document from another community is NotFound under this slug", async () => {
    const { s, id } = await uploaded();
    s.documents.rows[0]!.communityId = "dddddddd-0000-4000-8000-000000000000";

    await expect(
      s.remove.execute({ slug: "kelas-fisika", id, viewerId: OWNER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/**
 * **The gate Phase 5 exists to get right, and the tests that cannot pass by
 * omission.**
 *
 * One community holding BOTH an open document and a members-only one, so
 * every case below reads from a fixture where getting the rule backwards is
 * visible. A community with only one kind would let "always true" and "always
 * false" each pass half the suite.
 */
describe("the members-only gate", () => {
  async function library() {
    const s = subject();
    const open = await s.upload.execute(anUpload({ name: "Terbuka.pdf" }));
    const paid = await s.upload.execute(
      anUpload({ name: "Khusus.pdf", membersOnly: true })
    );
    return { s, openId: open.id, paidId: paid.id };
  }

  function rowFor(page: { documents: { id: string; mayDownload: boolean }[] }, id: string) {
    return page.documents.find((document) => document.id === id)!;
  }

  test("a member without a subscription gets the open one and not the paid one", async () => {
    const { s, openId, paidId } = await library();

    const page = await s.list.execute({ slug: "kelas-fisika", viewerId: MEMBER_ID });

    expect(rowFor(page, openId).mayDownload).toBe(true);
    expect(rowFor(page, paidId).mayDownload).toBe(false);
  });

  test("a member WITH an active subscription gets both", async () => {
    const { s, openId, paidId } = await library();
    s.subscriptions.grant(MEMBER_ID, COMMUNITY_ID, FUTURE);

    const page = await s.list.execute({ slug: "kelas-fisika", viewerId: MEMBER_ID });

    expect(rowFor(page, openId).mayDownload).toBe(true);
    expect(rowFor(page, paidId).mayDownload).toBe(true);
  });

  /**
   * A row whose period has passed is `status = 'active'` until the sweep
   * retires it — `findActiveForCommunity` is deliberately status-only, and
   * `membershipStanding` is what reads the period. A gate that trusted the
   * status alone would keep serving a lapsed member indefinitely.
   */
  test("a LAPSED subscription does not open the paid one", async () => {
    const { s, paidId } = await library();
    s.subscriptions.grant(MEMBER_ID, COMMUNITY_ID, PAST);

    const page = await s.list.execute({ slug: "kelas-fisika", viewerId: MEMBER_ID });

    expect(rowFor(page, paidId).mayDownload).toBe(false);
  });

  /**
   * `user_subscription_no_self` forbids subscribing to yourself, so the owner
   * can never hold a subscription to their own tier. A gate that asked about
   * subscriptions first would lock them out of their own library.
   */
  test("the owner gets both without holding any subscription", async () => {
    const { s, openId, paidId } = await library();

    const page = await s.list.execute({ slug: "kelas-fisika", viewerId: OWNER_ID });

    expect(rowFor(page, openId).mayDownload).toBe(true);
    expect(rowFor(page, paidId).mayDownload).toBe(true);
  });

  test("a non-member with a subscription somehow still gets nothing", async () => {
    const { s, openId, paidId } = await library();
    s.subscriptions.grant(STRANGER_ID, COMMUNITY_ID, FUTURE);

    const page = await s.list.execute({ slug: "kelas-fisika", viewerId: STRANGER_ID });

    // Membership is checked BEFORE the subscription: every subscriber is
    // meant to be a member, and a row that says otherwise is not a reason to
    // hand out bytes.
    expect(rowFor(page, openId).mayDownload).toBe(false);
    expect(rowFor(page, paidId).mayDownload).toBe(false);
  });

  test("everyone still SEES the whole list, including what they cannot open", async () => {
    const { s } = await library();

    const page = await s.list.execute({ slug: "kelas-fisika", viewerId: null });

    // Phase 1's argument for open reading: a community has to be evaluable
    // before joining, and a paywall that hides even the file names is not.
    expect(page.documents.map((document) => document.name).sort()).toEqual([
      "Khusus.pdf",
      "Terbuka.pdf",
    ]);
    expect(page.documents.every((document) => document.mayDownload === false)).toBe(true);
  });

  test("the download applies the SAME rule, not the list's flag", async () => {
    const { s, paidId } = await library();

    // The list said false for this member; asking directly must not differ.
    await expect(
      s.download.execute({ slug: "kelas-fisika", id: paidId, viewerId: MEMBER_ID })
    ).rejects.toBeInstanceOf(NotFoundError);

    s.subscriptions.grant(MEMBER_ID, COMMUNITY_ID, FUTURE);
    const allowed = await s.download.execute({
      slug: "kelas-fisika",
      id: paidId,
      viewerId: MEMBER_ID,
    });
    expect(allowed.name).toBe("Khusus.pdf");
  });

  test("an open document still downloads for a plain member", async () => {
    const { s, openId } = await library();

    const result = await s.download.execute({
      slug: "kelas-fisika",
      id: openId,
      viewerId: MEMBER_ID,
    });

    expect(result.name).toBe("Terbuka.pdf");
  });
});
