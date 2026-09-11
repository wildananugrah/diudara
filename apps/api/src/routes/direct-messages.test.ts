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

function authed(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function json(token: string) {
  return { "Content-Type": "application/json", ...authed(token) };
}

/** Two people in one community — the only pair allowed to open a conversation. */
async function twoMembers(a: ReturnType<typeof app>) {
  const owner = await signUp(a, "wildan");
  await a.request("/communities", {
    method: "POST",
    headers: json(owner),
    body: JSON.stringify({ name: "Kelas Desain", category: "Skill Digital" }),
  });
  const member = await signUp(a, "rina");
  await a.request("/communities/kelas-desain/join", { method: "POST", headers: authed(member) });
  return { owner, member };
}

function start(a: ReturnType<typeof app>, token: string, handle: string) {
  return a.request("/users/me/conversations", {
    method: "POST",
    headers: json(token),
    body: JSON.stringify({ handle }),
  });
}

describe("starting a conversation", () => {
  it("two members of the same community may", async () => {
    const a = app();
    const { owner, member } = await twoMembers(a);

    const res = await start(a, member, "wildan");

    expect(res.status).toBe(201);
    expect(await res.json()).toHaveProperty("id");
    // And the other side sees it.
    const theirs = await (
      await a.request("/users/me/conversations", { headers: authed(owner) })
    ).json();
    expect(theirs.conversations[0].other.handle).toBe("rina");
  });

  /**
   * **The same pair from either direction is ONE conversation.** Without the
   * canonical ordering this is two rows, and neither person sees the other's
   * messages — which looks exactly like being ignored.
   */
  it("opening from either direction gives the same thread", async () => {
    const a = app();
    const { owner, member } = await twoMembers(a);

    const opened = await (await start(a, member, "wildan")).json();
    const reopened = await (await start(a, owner, "rina")).json();

    expect(reopened.id).toBe(opened.id);
  });

  it("is idempotent from the same side too", async () => {
    const a = app();
    const { member } = await twoMembers(a);

    const first = await (await start(a, member, "wildan")).json();
    const second = await (await start(a, member, "wildan")).json();

    expect(second.id).toBe(first.id);
  });

  /** Open signup plus open DMs is a spam problem nobody chose. */
  it("a stranger who shares no community may not — 403", async () => {
    const a = app();
    await twoMembers(a);
    const stranger = await signUp(a, "asing");

    expect((await start(a, stranger, "wildan")).status).toBe(403);
  });

  it("messaging yourself is refused", async () => {
    const a = app();
    const { member } = await twoMembers(a);

    expect((await start(a, member, "rina")).status).toBe(400);
  });

  it("an unknown handle is 404", async () => {
    const a = app();
    const { member } = await twoMembers(a);

    expect((await start(a, member, "tidak-ada")).status).toBe(404);
  });
});

describe("sending and reading", () => {
  async function conversation() {
    const a = app();
    const { owner, member } = await twoMembers(a);
    const { id } = await (await start(a, member, "wildan")).json();
    return { a, owner, member, id };
  }

  function send(a: ReturnType<typeof app>, token: string, id: string, body: string) {
    return a.request(`/users/me/conversations/${id}/messages`, {
      method: "POST",
      headers: json(token),
      body: JSON.stringify({ body }),
    });
  }

  it("a message lands and both sides read it, oldest first", async () => {
    const { a, owner, member, id } = await conversation();

    await send(a, member, id, "halo kak");
    await send(a, owner, id, "halo juga");

    const thread = await (
      await a.request(`/users/me/conversations/${id}/messages`, { headers: authed(owner) })
    ).json();
    expect(thread.messages.map((m: { body: string }) => m.body)).toEqual([
      "halo kak",
      "halo juga",
    ]);
    expect(thread.messages[0].senderHandle).toBe("rina");
  });

  it("an empty message is refused", async () => {
    const { a, member, id } = await conversation();

    expect((await send(a, member, id, "   ")).status).toBe(400);
  });

  /**
   * **The asymmetry that IS the rule.** The shared-community check runs on
   * creating a conversation and never on sending into one — closing a thread
   * because somebody left would strand it mid-sentence.
   */
  it("replying still works after the shared community is left", async () => {
    const { a, member, id } = await conversation();

    const left = await a.request("/communities/kelas-desain/join", {
      method: "DELETE",
      headers: authed(member),
    });
    expect(left.status).toBe(200);

    expect((await send(a, member, id, "masih bisa")).status).toBe(201);
    // And REOPENING the existing thread still works: the gate guards creating
    // a conversation, not having one. `POST` answers 201 either way — it
    // hands back the resource, and a client only wants the id.
    const reopened = await start(a, member, "wildan");
    expect(reopened.status).toBe(201);
    expect((await reopened.json()).id).toBe(id);
  });

  it("but a BRAND-NEW conversation is still refused once you share nothing", async () => {
    const { a, member } = await conversation();
    const other = await signUp(a, "budi");
    // `budi` shares no community with anyone.
    expect((await start(a, member, "budi")).status).toBe(403);
    expect(other).toBeTruthy();
  });

  it("unread clears for the reader and not for the other side", async () => {
    const { a, owner, member, id } = await conversation();
    await send(a, member, id, "halo");

    await a.request(`/users/me/conversations/${id}/read`, {
      method: "POST",
      headers: authed(owner),
    });

    const ownerList = await (
      await a.request("/users/me/conversations", { headers: authed(owner) })
    ).json();
    expect(ownerList.conversations[0].unreadCount).toBe(0);
    // The sender never had one to clear.
    const memberList = await (
      await a.request("/users/me/conversations", { headers: authed(member) })
    ).json();
    expect(memberList.conversations[0].unreadCount).toBe(0);
  });

  /**
   * 404 and not 403 on every `:id` route — a 403 confirms the conversation
   * exists, which is what somebody probing ids wants to learn.
   */
  it.each([
    ["GET", "/messages", undefined],
    ["POST", "/messages", JSON.stringify({ body: "menyelinap" })],
    ["POST", "/read", undefined],
  ])("a non-participant gets 404 from %s %s", async (method, suffix, body) => {
    const { a, id } = await conversation();
    const stranger = await signUp(a, "asing");

    const res = await a.request(`/users/me/conversations/${id}${suffix}`, {
      method,
      headers: json(stranger),
      ...(body === undefined ? {} : { body }),
    });

    expect(res.status).toBe(404);
  });

  it.each([
    ["GET", "/users/me/conversations"],
    ["POST", "/users/me/conversations"],
  ])("%s %s requires auth", async (method, path) => {
    expect((await app().request(path, { method })).status).toBe(401);
  });
});
