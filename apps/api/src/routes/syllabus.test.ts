import { beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../app";
import { bootstrap } from "../bootstrap";
import { resetDatabase } from "../db/test-helpers";

beforeEach(resetDatabase);

function app() {
  return createApp(bootstrap());
}

async function signUp(a: ReturnType<typeof app>, handle: string) {
  const account = {
    handle,
    email: `${handle}@example.com`,
    password: "supersecret123",
    displayName: handle,
  };
  await a.request("/users/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(account),
  });
  const res = await a.request("/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  return (await res.json()).token as string;
}

const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ "Content-Type": "application/json", ...authed(token) });

async function ownedCommunity() {
  const a = app();
  const owner = await signUp(a, "wildan");
  await a.request("/communities", {
    method: "POST",
    headers: json(owner),
    body: JSON.stringify({ name: "Kelas Desain", category: "Skill Digital" }),
  });
  return { a, owner };
}

function addSection(a: ReturnType<typeof app>, token: string, title: string, position: number) {
  return a.request("/communities/kelas-desain/sections", {
    method: "POST",
    headers: json(token),
    body: JSON.stringify({ title, position }),
  });
}

function addLesson(
  a: ReturnType<typeof app>,
  token: string,
  body: Record<string, unknown>
) {
  return a.request("/communities/kelas-desain/lessons", {
    method: "POST",
    headers: json(token),
    body: JSON.stringify(body),
  });
}

async function uploadDocument(
  a: ReturnType<typeof app>,
  token: string,
  membersOnly = false
) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], "Modul.pdf", { type: "application/pdf" }));
  if (membersOnly) form.set("membersOnly", "true");
  const res = await a.request("/communities/kelas-desain/documents", {
    method: "POST",
    headers: authed(token),
    body: form,
  });
  return (await res.json()).id as string;
}

function syllabus(a: ReturnType<typeof app>) {
  return a.request("/communities/kelas-desain/syllabus");
}

describe("the syllabus", () => {
  it("is readable signed out, and empty to begin with", async () => {
    const { a } = await ownedCommunity();

    const res = await syllabus(a);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sections: [] });
  });

  it("the owner builds sections and lessons, and the count is the real one", async () => {
    const { a, owner } = await ownedCommunity();
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();
    await addLesson(a, owner, {
      sectionId: section.id,
      title: "Pengenalan",
      body: "mulai dari sini",
      position: 1,
    });
    await addLesson(a, owner, {
      sectionId: section.id,
      title: "Latihan",
      body: "kerjakan ini",
      position: 2,
    });

    const body = await (await syllabus(a)).json();

    expect(body.sections[0].title).toBe("Minggu 1");
    expect(body.sections[0].lessons.map((l: { title: string }) => l.title)).toEqual([
      "Pengenalan",
      "Latihan",
    ]);
    // Computed, never stored — a stored count drifts the first time a lesson
    // is added by a path that forgets it.
    expect(body.sections[0].lessonCount).toBe(2);
  });

  it("a lesson with no attachment reports null rather than an empty object", async () => {
    const { a, owner } = await ownedCommunity();
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();
    await addLesson(a, owner, {
      sectionId: section.id,
      title: "Teks saja",
      body: "tidak ada lampiran",
      position: 1,
    });

    const body = await (await syllabus(a)).json();
    expect(body.sections[0].lessons[0].attachment).toBeNull();
  });

  /**
   * **The seam between this phase and 4a.** The lock is reported from the
   * DOCUMENT, so a lesson never carries a second, weaker gate of its own.
   */
  it("reports an attached document's lock from the document itself", async () => {
    const { a, owner } = await ownedCommunity();
    const open = await uploadDocument(a, owner, false);
    const paid = await uploadDocument(a, owner, true);
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();
    await addLesson(a, owner, {
      sectionId: section.id,
      title: "Terbuka",
      body: "x",
      position: 1,
      documentId: open,
    });
    await addLesson(a, owner, {
      sectionId: section.id,
      title: "Khusus",
      body: "y",
      position: 2,
      documentId: paid,
    });

    const lessons = (await (await syllabus(a)).json()).sections[0].lessons;

    expect(lessons[0].attachment.membersOnly).toBe(false);
    expect(lessons[1].attachment.membersOnly).toBe(true);
    expect(lessons[0].attachment.name).toBe("Modul.pdf");
  });

  it("a deleted document leaves its lesson, without the attachment", async () => {
    const { a, owner } = await ownedCommunity();
    const documentId = await uploadDocument(a, owner);
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();
    await addLesson(a, owner, {
      sectionId: section.id,
      title: "Modul",
      body: "baca ini",
      position: 1,
      documentId,
    });

    await a.request(`/communities/kelas-desain/documents/${documentId}`, {
      method: "DELETE",
      headers: authed(owner),
    });

    const lessons = (await (await syllabus(a)).json()).sections[0].lessons;
    // The lesson somebody WROTE must not vanish because a PDF was tidied away.
    expect(lessons.length).toBe(1);
    expect(lessons[0].title).toBe("Modul");
    expect(lessons[0].attachment).toBeNull();
  });

  it("deleting a section takes its lessons", async () => {
    const { a, owner } = await ownedCommunity();
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();
    await addLesson(a, owner, { sectionId: section.id, title: "Ikut", body: "x", position: 1 });

    const res = await a.request(`/communities/kelas-desain/sections/${section.id}`, {
      method: "DELETE",
      headers: authed(owner),
    });

    expect(res.status).toBe(200);
    expect((await (await syllabus(a)).json()).sections).toEqual([]);
  });

  it("deleting a lesson leaves its section", async () => {
    const { a, owner } = await ownedCommunity();
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();
    const lesson = await (
      await addLesson(a, owner, { sectionId: section.id, title: "Hapus", body: "x", position: 1 })
    ).json();

    await a.request(`/communities/kelas-desain/lessons/${lesson.id}`, {
      method: "DELETE",
      headers: authed(owner),
    });

    const body = await (await syllabus(a)).json();
    expect(body.sections.length).toBe(1);
    expect(body.sections[0].lessons).toEqual([]);
  });

  it.each([
    ["a section", "/communities/kelas-desain/sections", { title: "Punya saya", position: 1 }],
    [
      "a lesson",
      "/communities/kelas-desain/lessons",
      { sectionId: "ffffffff-0000-4000-8000-000000000000", title: "x", body: "y", position: 1 },
    ],
  ])("a member may not create %s — 403", async (_label, path, payload) => {
    const { a } = await ownedCommunity();
    const member = await signUp(a, "rina");
    await a.request("/communities/kelas-desain/join", { method: "POST", headers: authed(member) });

    const res = await a.request(path, {
      method: "POST",
      headers: json(member),
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(403);
  });

  /**
   * A lesson hung off another community's section would be invisible to its
   * author and visible on somebody else's syllabus.
   */
  it("a section from another community is 404, not 403", async () => {
    const { a, owner } = await ownedCommunity();
    const other = await signUp(a, "budi");
    await a.request("/communities", {
      method: "POST",
      headers: json(other),
      body: JSON.stringify({ name: "Kelas Lain", category: "Skill Digital" }),
    });
    const theirSection = await (
      await a.request("/communities/kelas-lain/sections", {
        method: "POST",
        headers: json(other),
        body: JSON.stringify({ title: "Punya mereka", position: 1 }),
      })
    ).json();

    const res = await addLesson(a, owner, {
      sectionId: theirSection.id,
      title: "Menyelinap",
      body: "x",
      position: 1,
    });

    expect(res.status).toBe(404);
  });

  it("an unknown slug is 404", async () => {
    const { a } = await ownedCommunity();
    expect((await a.request("/communities/tidak-ada/syllabus")).status).toBe(404);
  });

  it("an empty lesson body is refused", async () => {
    const { a, owner } = await ownedCommunity();
    const section = await (await addSection(a, owner, "Minggu 1", 1)).json();

    const res = await addLesson(a, owner, {
      sectionId: section.id,
      title: "Kosong",
      body: "   ",
      position: 1,
    });

    expect(res.status).toBe(400);
  });
});
