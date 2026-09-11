import { describe, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type { DocumentRepositoryPort, DocumentRow } from "../ports/document-repository.port";
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
  }): Promise<DocumentRow> {
    const row: DocumentRow = {
      id: input.id,
      communityId: input.communityId,
      name: input.name,
      contentType: input.contentType,
      byteSize: input.byteSize,
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
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

/** A failing repository, for the compensating-delete test. */
class ExplodingDocuments extends FakeDocuments {
  override async create(): Promise<DocumentRow> {
    throw new Error("database is on fire");
  }
}

function subject(documents: DocumentRepositoryPort = new FakeDocuments()) {
  const communities = new FakeCommunities([community()]);
  const storage = new FakeDocumentStorageAdapter();
  return {
    communities,
    documents: documents as FakeDocuments,
    storage,
    upload: new UploadCommunityDocument(communities, documents, storage),
    list: new ListCommunityDocuments(communities, documents),
    download: new DownloadCommunityDocument(communities, documents, storage),
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

  test("says whether THIS viewer may download, so no dead control is rendered", async () => {
    const s = subject();
    await s.upload.execute(anUpload());

    const asMember = await s.list.execute({ slug: "kelas-fisika", viewerId: MEMBER_ID });
    const asStranger = await s.list.execute({ slug: "kelas-fisika", viewerId: STRANGER_ID });
    const signedOut = await s.list.execute({ slug: "kelas-fisika", viewerId: null });

    expect(asMember.viewerMayDownload).toBe(true);
    expect(asStranger.viewerMayDownload).toBe(false);
    expect(signedOut.viewerMayDownload).toBe(false);
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
