import { describe, expect, test } from "bun:test";
import { CommunityService } from "./CommunityService.ts";
import { AccessPolicy } from "./AccessPolicy.ts";
import type {
  MembershipRepository, QuizRepository, SyllabusRepository, UploadRepository,
} from "../domain/ports.ts";
import type { MemberRole, MemberStatus } from "../domain/types.ts";

const COMMUNITY = "bimbel-sbmptn";
const OTHER = "finansial-cerdas";

/**
 * Real AccessPolicy over a fake membership table, so these tests exercise the
 * actual authorisation path rather than a stub that always says yes.
 */
function makeService(roles: Record<string, { role: MemberRole; status?: MemberStatus }>) {
  const writes: Array<{ op: string; args: unknown }> = [];

  const memberships = {
    find: async (communityId: string, userId: string) => {
      const m = roles[`${communityId}:${userId}`];
      return m ? { communityId, userId, role: m.role, status: m.status ?? "active", joinedAt: new Date() } : null;
    },
  } as unknown as MembershipRepository;

  const syllabi = {
    listForCommunity: async () => [],
    // "week-1" belongs to COMMUNITY; "week-x" belongs to OTHER.
    findGroup: async (id: string) =>
      id === "week-1" ? { id, communityId: COMMUNITY, title: "Minggu 1" }
      : id === "week-x" ? { id, communityId: OTHER, title: "Lain" }
      : null,
    findItem: async (id: string) =>
      id === "item-1" ? { id, syllabusId: "week-1", communityId: COMMUNITY, type: "video" }
      : id === "item-ebook" ? { id, syllabusId: "week-1", communityId: COMMUNITY, type: "ebook" }
      : null,
    createGroup: async (args: unknown) => { writes.push({ op: "createGroup", args }); return { id: "g1", title: "x", items: [] }; },
    updateGroup: async (id: string, args: unknown) => { writes.push({ op: "updateGroup", args }); return { id, title: "x", items: [] }; },
    deleteGroup: async (id: string) => { writes.push({ op: "deleteGroup", args: id }); },
    createItem: async (args: unknown) => { writes.push({ op: "createItem", args }); return { id: "i1", title: "x", type: "video", duration: "" }; },
    updateItem: async (id: string, args: unknown) => { writes.push({ op: "updateItem", args }); return { id, title: "x", type: "video", duration: "" }; },
    deleteItem: async (id: string) => { writes.push({ op: "deleteItem", args: id }); },
  } as unknown as SyllabusRepository;

  // Only "up-1" was ever uploaded; anything else must be rejected as a bad reference.
  const uploads = {
    existingIds: async (ids: string[]) => ids.filter((i) => i === "up-1"),
  } as unknown as UploadRepository;

  const quizzes = {
    listForItem: async () => [],
    // "q-1" hangs off item-1 in COMMUNITY; "q-x" belongs to OTHER.
    findQuestion: async (id: string) =>
      id === "q-1" ? { id, itemId: "item-1", communityId: COMMUNITY }
      : id === "q-x" ? { id, itemId: "item-x", communityId: OTHER }
      : null,
    createQuestion: async (args: unknown) => { writes.push({ op: "createQuestion", args }); return { id: "q1" } as never; },
    updateQuestion: async (id: string, args: unknown) => { writes.push({ op: "updateQuestion", args }); return { id } as never; },
    deleteQuestion: async (id: string) => { writes.push({ op: "deleteQuestion", args: id }); },
  } as unknown as QuizRepository;

  const service = new CommunityService(
    {} as never, memberships, {} as never, syllabi, quizzes, {} as never, uploads, {} as never,
    new AccessPolicy(memberships),
  );
  return { service, writes };
}

/** A well-formed multiple-choice question, for tests that vary one thing about it. */
const goodQuestion = {
  prompt: "Berapa 2 + 2?",
  format: "multiple_choice",
  options: [
    { text: "3", isCorrect: false },
    { text: "4", isCorrect: true },
  ],
};

const asAdmin = () => makeService({ [`${COMMUNITY}:admin`]: { role: "admin" } });

describe("materi authoring", () => {
  test("only an admin of that community may create a silabus", async () => {
    const { service } = makeService({
      [`${COMMUNITY}:member`]: { role: "member" },
      [`${COMMUNITY}:admin`]: { role: "admin" },
    });
    await expect(service.createMateri(COMMUNITY, "member", { title: "Minggu 1" })).rejects.toThrow();
    await expect(service.createMateri(COMMUNITY, "nobody", { title: "Minggu 1" })).rejects.toThrow();
    await expect(service.createMateri(COMMUNITY, "admin", { title: "Minggu 1" })).resolves.toBeDefined();
  });

  test("an inactive admin is not an admin", async () => {
    const { service } = makeService({ [`${COMMUNITY}:ghost`]: { role: "admin", status: "churned" } });
    await expect(service.createMateri(COMMUNITY, "ghost", { title: "Minggu 1" })).rejects.toThrow();
  });

  test("authorises against the row's own community, not the caller's claim", async () => {
    // "admin" runs COMMUNITY. week-x belongs to OTHER, so this must be refused —
    // otherwise an admin of any community could edit every community's materi.
    const { service } = asAdmin();
    await expect(service.updateMateri("week-x", "admin", { title: "Ubah" })).rejects.toThrow();
    await expect(service.deleteMateri("week-x", "admin")).rejects.toThrow();
    await expect(service.createMateriItem("week-x", "admin", { title: "A", type: "video" })).rejects.toThrow();
  });

  test("404s on a silabus or item that does not exist", async () => {
    const { service } = asAdmin();
    await expect(service.updateMateri("ghost", "admin", { title: "x" })).rejects.toThrow(/tidak ditemukan|Silabus/i);
    await expect(service.updateMateriItem("ghost", "admin", { title: "x" })).rejects.toThrow(/tidak ditemukan|Materi/i);
  });

  test("rejects an item type the Materi tab cannot render", async () => {
    const { service } = asAdmin();
    for (const type of ["pdf", "VIDEO", "", "webinar"]) {
      await expect(service.createMateriItem("week-1", "admin", { title: "A", type })).rejects.toThrow(/Tipe materi tidak valid/);
    }
    for (const type of ["video", "ebook", "audio", "quiz"]) {
      await expect(service.createMateriItem("week-1", "admin", { title: "A", type })).resolves.toBeDefined();
    }
  });

  test("rejects a blank title and trims the rest", async () => {
    const { service, writes } = asAdmin();
    await expect(service.createMateri(COMMUNITY, "admin", { title: "   " })).rejects.toThrow(/Judul wajib diisi/);
    await expect(service.createMateriItem("week-1", "admin", { title: "", type: "video" })).rejects.toThrow(/Judul wajib diisi/);

    await service.createMateri(COMMUNITY, "admin", { title: "  Minggu 2  " });
    expect(writes.at(-1)).toEqual({ op: "createGroup", args: { communityId: COMMUNITY, title: "Minggu 2" } });

    await service.createMateriItem("week-1", "admin", { title: "  Limit  ", type: "video", duration: "  9:45  " });
    expect(writes.at(-1)).toEqual({
      op: "createItem",
      args: { syllabusId: "week-1", title: "Limit", type: "video", duration: "9:45", uploadId: null, sourceUrl: null },
    });
  });

  test("rejects an uploadId that was never uploaded", async () => {
    // Without this the bad id reaches the FK and surfaces as a 500, not a 422.
    const { service } = asAdmin();
    await expect(
      service.createMateriItem("week-1", "admin", { title: "A", type: "video", uploadId: "nope" }),
    ).rejects.toThrow(/Lampiran tidak ditemukan/);
    await expect(
      service.updateMateriItem("item-1", "admin", { uploadId: "nope" }),
    ).rejects.toThrow(/Lampiran tidak ditemukan/);
  });

  test("attaches a real upload, and null detaches it", async () => {
    const { service, writes } = asAdmin();
    await service.createMateriItem("week-1", "admin", { title: "Video", type: "video", uploadId: "up-1" });
    expect((writes.at(-1)!.args as { uploadId: string }).uploadId).toBe("up-1");

    // null must survive to the repo as null (detach), not be treated as "absent".
    await service.updateMateriItem("item-1", "admin", { uploadId: null });
    expect((writes.at(-1)!.args as { uploadId: null }).uploadId).toBeNull();
  });

  test("an item with no file is still valid — outline first, upload later", async () => {
    const { service, writes } = asAdmin();
    await service.createMateriItem("week-1", "admin", { title: "Belum ada file", type: "ebook" });
    expect((writes.at(-1)!.args as { uploadId: string | null }).uploadId).toBeNull();
  });

  test("accepts a YouTube link as the source", async () => {
    const { service, writes } = asAdmin();
    await service.createMateriItem("week-1", "admin", {
      title: "Video", type: "video", sourceUrl: "  https://youtu.be/dQw4w9WgXcQ?t=30  ",
    });
    const args = writes.at(-1)!.args as { sourceUrl: string; uploadId: null };
    // Stored as pasted (timestamp intact); the embed URL is derived on read.
    expect(args.sourceUrl).toBe("https://youtu.be/dQw4w9WgXcQ?t=30");
    expect(args.uploadId).toBeNull();
  });

  test("refuses a file and a link at the same time", async () => {
    // Two sources would leave the player guessing which one the creator meant.
    const { service } = asAdmin();
    await expect(service.createMateriItem("week-1", "admin", {
      title: "A", type: "video", uploadId: "up-1", sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
    })).rejects.toThrow(/salah satu/i);
  });

  test("rejects a link that is not a YouTube video", async () => {
    const { service } = asAdmin();
    for (const sourceUrl of ["https://vimeo.com/123", "https://example.com/v.mp4", "not a url"]) {
      await expect(service.createMateriItem("week-1", "admin", { title: "A", type: "video", sourceUrl }))
        .rejects.toThrow(/Tautan tidak dikenali/);
    }
  });

  test("each type accepts the links its label promises", async () => {
    const { service } = asAdmin();
    const yt = "https://youtu.be/dQw4w9WgXcQ";
    const mp3 = "https://situs.com/rekaman.mp3";
    const pdf = "https://drive.google.com/file/d/abc/view";
    const create = (type: string, sourceUrl: string) =>
      service.createMateriItem("week-1", "admin", { title: "A", type, sourceUrl });

    // Video is embedded in a player, so it must be an embeddable source.
    await expect(create("video", yt)).resolves.toBeDefined();
    await expect(create("video", mp3)).rejects.toThrow(/YouTube/);

    // Audio plays either way: YouTube embed, or a direct file in <audio>.
    await expect(create("audio", yt)).resolves.toBeDefined();
    await expect(create("audio", mp3)).resolves.toBeDefined();

    // An e-book just opens, so any reachable document URL is fine.
    await expect(create("ebook", pdf)).resolves.toBeDefined();

    // A quiz carries questions, never a source.
    await expect(create("quiz", yt)).rejects.toThrow(/hanya bisa diisi file unggahan/);
  });

  test("refuses a link whose scheme could execute in a member's browser", async () => {
    // This link is rendered in someone else's page; javascript:/data: must die here.
    const { service } = asAdmin();
    for (const type of ["audio", "ebook"]) {
      for (const sourceUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
        await expect(service.createMateriItem("week-1", "admin", { title: "A", type, sourceUrl }))
          .rejects.toThrow(/Tautan tidak dikenali/);
      }
    }
  });

  test("patching a link onto an existing ebook is now allowed", async () => {
    const { service } = asAdmin();
    await expect(service.updateMateriItem("item-ebook", "admin", {
      sourceUrl: "https://drive.google.com/file/d/abc/view",
    })).resolves.toBeDefined();
  });

  test("omitting sourceUrl on a patch leaves the existing link alone", async () => {
    // undefined means "don't touch"; null means "detach". They must not collapse.
    const { service, writes } = asAdmin();
    await service.updateMateriItem("item-1", "admin", { title: "Baru" });
    expect((writes.at(-1)!.args as { sourceUrl: undefined }).sourceUrl).toBeUndefined();

    await service.updateMateriItem("item-1", "admin", { sourceUrl: null });
    expect((writes.at(-1)!.args as { sourceUrl: null }).sourceUrl).toBeNull();
  });

  test("a patch that omits a field leaves it untouched", async () => {
    // undefined must stay undefined, not become "" — that would blank the title.
    const { service, writes } = asAdmin();
    await service.updateMateriItem("item-1", "admin", { sortOrder: 3 });
    expect(writes.at(-1)).toEqual({
      op: "updateItem",
      args: { title: undefined, type: undefined, duration: undefined, sortOrder: 3 },
    });
  });
});

describe("quiz authoring", () => {
  test("only an admin of that community may author questions", async () => {
    const { service } = makeService({
      [`${COMMUNITY}:member`]: { role: "member" },
      [`${COMMUNITY}:admin`]: { role: "admin" },
    });
    await expect(service.createQuizQuestion("item-1", "member", goodQuestion)).rejects.toThrow();
    await expect(service.createQuizQuestion("item-1", "admin", goodQuestion)).resolves.toBeDefined();
  });

  test("authorises a question against its own community", async () => {
    // q-x belongs to OTHER; an admin of COMMUNITY must not touch it.
    const { service } = asAdmin();
    await expect(service.updateQuizQuestion("q-x", "admin", { prompt: "Ubah" })).rejects.toThrow();
    await expect(service.deleteQuizQuestion("q-x", "admin")).rejects.toThrow();
  });

  test("requires exactly one correct answer", async () => {
    const { service } = asAdmin();
    const withOptions = (options: Array<{ text: string; isCorrect: boolean }>) =>
      service.createQuizQuestion("item-1", "admin", { ...goodQuestion, options });

    await expect(withOptions([{ text: "3", isCorrect: false }, { text: "4", isCorrect: false }]))
      .rejects.toThrow(/Tandai satu jawaban yang benar/);
    await expect(withOptions([{ text: "3", isCorrect: true }, { text: "4", isCorrect: true }]))
      .rejects.toThrow(/Hanya boleh ada satu jawaban benar/);
  });

  test("requires at least two non-blank options", async () => {
    const { service } = asAdmin();
    const withOptions = (options: Array<{ text: string; isCorrect: boolean }>) =>
      service.createQuizQuestion("item-1", "admin", { ...goodQuestion, options });

    await expect(withOptions([{ text: "4", isCorrect: true }])).rejects.toThrow(/minimal 2 pilihan/);
    await expect(withOptions([])).rejects.toThrow(/minimal 2 pilihan/);
    // Blank options are dropped before counting, so this is really a 1-option question.
    await expect(withOptions([{ text: "4", isCorrect: true }, { text: "   ", isCorrect: false }]))
      .rejects.toThrow(/minimal 2 pilihan/);
  });

  test("true/false must have exactly two options", async () => {
    const { service } = asAdmin();
    await expect(service.createQuizQuestion("item-1", "admin", {
      prompt: "Langit biru?", format: "true_false",
      options: [
        { text: "Benar", isCorrect: true }, { text: "Salah", isCorrect: false }, { text: "Mungkin", isCorrect: false },
      ],
    })).rejects.toThrow(/tepat 2 pilihan/);
  });

  test("rejects a blank prompt and an unknown format", async () => {
    const { service } = asAdmin();
    await expect(service.createQuizQuestion("item-1", "admin", { ...goodQuestion, prompt: "  " }))
      .rejects.toThrow(/Pertanyaan wajib diisi/);
    await expect(service.createQuizQuestion("item-1", "admin", { ...goodQuestion, format: "essay" }))
      .rejects.toThrow(/Format soal tidak valid/);
  });

  test("trims text and normalises a missing explanation to null", async () => {
    const { service, writes } = asAdmin();
    await service.createQuizQuestion("item-1", "admin", {
      prompt: "  Berapa 2 + 2?  ", format: "multiple_choice", explanation: "   ",
      options: [{ text: "  3  ", isCorrect: false }, { text: " 4 ", isCorrect: true }],
    });
    expect(writes.at(-1)!.args).toEqual({
      itemId: "item-1",
      prompt: "Berapa 2 + 2?",
      format: "multiple_choice",
      explanation: null,
      options: [{ text: "3", isCorrect: false }, { text: "4", isCorrect: true }],
    });
  });

  test("a patch without options leaves the existing ones alone", async () => {
    const { service, writes } = asAdmin();
    await service.updateQuizQuestion("q-1", "admin", { prompt: "Baru" });
    expect((writes.at(-1)!.args as { options: undefined }).options).toBeUndefined();
  });
});
