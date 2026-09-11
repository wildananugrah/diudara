import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, communities, communityDocuments } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleSyllabusRepository } from "./drizzle-syllabus.repository";

const repository = new DrizzleSyllabusRepository(db);

let counter = 0;

async function seedCommunity() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `teacher${counter}`,
      email: `teacher${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Teacher ${counter}`,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: user!.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();
  return { userId: user!.id, communityId: community!.id };
}

async function seedDocument(communityId: string, uploaderId: string, membersOnly = false) {
  const [row] = await db
    .insert(communityDocuments)
    .values({
      communityId,
      uploaderId,
      name: "Modul.pdf",
      contentType: "application/pdf",
      byteSize: 2_400_000,
      membersOnly,
    })
    .returning();
  return row!;
}

describe("DrizzleSyllabusRepository — ordering", () => {
  beforeEach(resetDatabase);

  test("sections come back by position", async () => {
    const { communityId } = await seedCommunity();
    await repository.createSection({ communityId, title: "Kedua", position: 2 });
    await repository.createSection({ communityId, title: "Pertama", position: 1 });

    expect((await repository.listSections(communityId)).map((s) => s.title)).toEqual([
      "Pertama",
      "Kedua",
    ]);
  });

  /**
   * **The ordering must be TOTAL.** Two sections at the same position is a
   * state the schema permits, and without the tiebreakers the syllabus
   * reorders itself between page loads — which reads as data loss to whoever
   * is looking at it, not as a sorting quirk.
   */
  test("a tie is broken stably, across repeated reads", async () => {
    const { communityId } = await seedCommunity();
    await repository.createSection({ communityId, title: "A", position: 1 });
    await repository.createSection({ communityId, title: "B", position: 1 });
    await repository.createSection({ communityId, title: "C", position: 1 });

    const first = (await repository.listSections(communityId)).map((s) => s.title);
    const second = (await repository.listSections(communityId)).map((s) => s.title);
    const third = (await repository.listSections(communityId)).map((s) => s.title);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test("lessons come back by position, and a tie is stable too", async () => {
    const { communityId } = await seedCommunity();
    const section = await repository.createSection({ communityId, title: "Minggu 1", position: 1 });
    await repository.createLesson({ sectionId: section.id, title: "Kedua", body: "b", position: 2 });
    await repository.createLesson({ sectionId: section.id, title: "Pertama", body: "a", position: 1 });
    await repository.createLesson({ sectionId: section.id, title: "Juga", body: "c", position: 1 });

    const titles = (await repository.listLessons(communityId)).map((l) => l.title);
    expect(titles[titles.length - 1]).toBe("Kedua");
    expect(await repository.listLessons(communityId).then((r) => r.map((l) => l.title))).toEqual(
      titles
    );
  });
});

describe("DrizzleSyllabusRepository — the attachment", () => {
  beforeEach(resetDatabase);

  test("a lesson carries its document's name, size and lock", async () => {
    const { communityId, userId } = await seedCommunity();
    const document = await seedDocument(communityId, userId, true);
    const section = await repository.createSection({ communityId, title: "Minggu 1", position: 1 });

    const lesson = await repository.createLesson({
      sectionId: section.id,
      title: "Modul",
      body: "baca ini",
      position: 1,
      documentId: document.id,
    });

    expect(lesson.documentId).toBe(document.id);
    expect(lesson.documentName).toBe("Modul.pdf");
    expect(lesson.documentByteSize).toBe(2_400_000);
    expect(lesson.documentMembersOnly).toBe(true);
  });

  test("a lesson with no attachment reports false rather than null for the lock", async () => {
    const { communityId } = await seedCommunity();
    const section = await repository.createSection({ communityId, title: "Minggu 1", position: 1 });

    const lesson = await repository.createLesson({
      sectionId: section.id,
      title: "Teks saja",
      body: "tidak ada lampiran",
      position: 1,
    });

    expect(lesson.documentId).toBeNull();
    // "Nothing is locked here" is the honest answer, and a nullable boolean
    // would make every reader write `=== true`.
    expect(lesson.documentMembersOnly).toBe(false);
  });

  /**
   * The join's predicate lives in its ON, not its WHERE. In the WHERE it would
   * drop the LESSON whose document was deleted — losing somebody's written
   * lesson because a PDF was tidied away.
   */
  test("a soft-deleted document leaves its lesson intact, without an attachment", async () => {
    const { communityId, userId } = await seedCommunity();
    const document = await seedDocument(communityId, userId);
    const section = await repository.createSection({ communityId, title: "Minggu 1", position: 1 });
    await repository.createLesson({
      sectionId: section.id,
      title: "Modul",
      body: "baca ini",
      position: 1,
      documentId: document.id,
    });

    await db
      .update(communityDocuments)
      .set({ deletedAt: new Date() })
      .where(eq(communityDocuments.id, document.id));

    const lessons = await repository.listLessons(communityId);
    expect(lessons.length).toBe(1);
    expect(lessons[0]!.title).toBe("Modul");
    expect(lessons[0]!.documentId).toBeNull();
    expect(lessons[0]!.documentName).toBeNull();
  });
});

describe("DrizzleSyllabusRepository — scope and deletion", () => {
  beforeEach(resetDatabase);

  test("another community's syllabus is absent", async () => {
    const mine = await seedCommunity();
    const theirs = await seedCommunity();
    const theirSection = await repository.createSection({
      communityId: theirs.communityId,
      title: "Punya mereka",
      position: 1,
    });
    await repository.createLesson({
      sectionId: theirSection.id,
      title: "Materi mereka",
      body: "x",
      position: 1,
    });
    await repository.createSection({ communityId: mine.communityId, title: "Punya saya", position: 1 });

    expect((await repository.listSections(mine.communityId)).map((s) => s.title)).toEqual([
      "Punya saya",
    ]);
    expect(await repository.listLessons(mine.communityId)).toEqual([]);
  });

  test("a section and a lesson only resolve within their own community", async () => {
    const mine = await seedCommunity();
    const theirs = await seedCommunity();
    const section = await repository.createSection({
      communityId: theirs.communityId,
      title: "Punya mereka",
      position: 1,
    });
    const lesson = await repository.createLesson({
      sectionId: section.id,
      title: "Materi",
      body: "x",
      position: 1,
    });

    expect(await repository.findSectionIn(theirs.communityId, section.id)).not.toBeNull();
    expect(await repository.findSectionIn(mine.communityId, section.id)).toBeNull();
    expect(await repository.findLessonIn(theirs.communityId, lesson.id)).not.toBeNull();
    expect(await repository.findLessonIn(mine.communityId, lesson.id)).toBeNull();
  });

  /**
   * Refusing while lessons remain would make an owner delete a dozen things
   * to remove one, and a lesson under no section is unreachable by every read
   * path — deleted in effect, but still occupying a row.
   */
  test("deleting a section takes its lessons, and nothing else's", async () => {
    const { communityId } = await seedCommunity();
    const doomed = await repository.createSection({ communityId, title: "Hapus", position: 1 });
    const kept = await repository.createSection({ communityId, title: "Simpan", position: 2 });
    await repository.createLesson({ sectionId: doomed.id, title: "Ikut hapus", body: "x", position: 1 });
    await repository.createLesson({ sectionId: kept.id, title: "Tetap ada", body: "y", position: 1 });

    await repository.deleteSection(doomed.id);

    expect((await repository.listSections(communityId)).map((s) => s.title)).toEqual(["Simpan"]);
    expect((await repository.listLessons(communityId)).map((l) => l.title)).toEqual(["Tetap ada"]);
  });

  test("deleting a lesson leaves its section", async () => {
    const { communityId } = await seedCommunity();
    const section = await repository.createSection({ communityId, title: "Minggu 1", position: 1 });
    const lesson = await repository.createLesson({
      sectionId: section.id,
      title: "Hapus",
      body: "x",
      position: 1,
    });

    await repository.deleteLesson(lesson.id);

    expect((await repository.listSections(communityId)).length).toBe(1);
    expect(await repository.listLessons(communityId)).toEqual([]);
  });
});
