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

function bell(a: ReturnType<typeof app>, token: string) {
  return a.request("/users/me/notifications", { headers: authed(token) });
}

describe("the notification bell", () => {
  it("is empty for a new account", async () => {
    const a = app();
    const token = await signUp(a, "wildan");

    const body = await (await bell(a, token)).json();

    expect(body).toEqual({ notifications: [], unreadCount: 0 });
  });

  it("a follow notifies the person followed, naming the actor", async () => {
    const a = app();
    const target = await signUp(a, "wildan");
    const follower = await signUp(a, "rina");

    await a.request("/users/wildan/follow", { method: "POST", headers: authed(follower) });

    const body = await (await bell(a, target)).json();
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0].kind).toBe("follow");
    expect(body.notifications[0].actor.handle).toBe("rina");
    // NO href on the wire — the client builds the link from the kind and ids.
    expect(Object.keys(body.notifications[0]).sort()).toEqual([
      "actor",
      "communitySlug",
      "createdAt",
      "id",
      "kind",
      "postId",
      "read",
    ]);
  });

  it("the FOLLOWER is told nothing — a notification goes to its recipient", async () => {
    const a = app();
    await signUp(a, "wildan");
    const follower = await signUp(a, "rina");

    await a.request("/users/wildan/follow", { method: "POST", headers: authed(follower) });

    expect((await (await bell(a, follower)).json()).unreadCount).toBe(0);
  });

  it("a join notifies the community's owner and carries the slug", async () => {
    const a = app();
    const owner = await signUp(a, "wildan");
    await a.request("/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(owner) },
      body: JSON.stringify({ name: "Kelas Desain", category: "Skill Digital" }),
    });
    const joiner = await signUp(a, "rina");

    await a.request("/communities/kelas-desain/join", {
      method: "POST",
      headers: authed(joiner),
    });

    const body = await (await bell(a, owner)).json();
    expect(body.notifications[0].kind).toBe("join");
    expect(body.notifications[0].communitySlug).toBe("kelas-desain");
  });

  it("a comment notifies the post's author and carries the post id", async () => {
    const a = app();
    const owner = await signUp(a, "wildan");
    await a.request("/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(owner) },
      body: JSON.stringify({ name: "Kelas Desain", category: "Skill Digital" }),
    });
    const post = await (
      await a.request("/communities/kelas-desain/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authed(owner) },
        body: JSON.stringify({ body: "halo semua" }),
      })
    ).json();
    const member = await signUp(a, "rina");
    await a.request("/communities/kelas-desain/join", { method: "POST", headers: authed(member) });

    await a.request(`/users/posts/${post.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(member) },
      body: JSON.stringify({ body: "setuju" }),
    });

    const body = await (await bell(a, owner)).json();
    expect(body.notifications[0].kind).toBe("comment");
    expect(body.notifications[0].postId).toBe(post.id);
  });

  /**
   * Commenting on your own post must report nothing. `NotifyOf` is where that
   * rule lives; this proves it holds through the real endpoints.
   */
  it("commenting on your own post notifies nobody", async () => {
    const a = app();
    const owner = await signUp(a, "wildan");
    await a.request("/communities", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(owner) },
      body: JSON.stringify({ name: "Kelas Desain", category: "Skill Digital" }),
    });
    const post = await (
      await a.request("/communities/kelas-desain/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authed(owner) },
        body: JSON.stringify({ body: "halo semua" }),
      })
    ).json();

    await a.request(`/users/posts/${post.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authed(owner) },
      body: JSON.stringify({ body: "menambahkan" }),
    });

    expect((await (await bell(a, owner)).json()).unreadCount).toBe(0);
  });

  it("reading clears the count but keeps the history", async () => {
    const a = app();
    const target = await signUp(a, "wildan");
    const follower = await signUp(a, "rina");
    await a.request("/users/wildan/follow", { method: "POST", headers: authed(follower) });

    const res = await a.request("/users/me/notifications/read", {
      method: "POST",
      headers: authed(target),
    });

    expect(res.status).toBe(200);
    const body = await (await bell(a, target)).json();
    expect(body.unreadCount).toBe(0);
    // The list is a HISTORY, not an inbox — reading does not delete.
    expect(body.notifications.length).toBe(1);
    expect(body.notifications[0].read).toBe(true);
  });

  it("reading twice is harmless", async () => {
    const a = app();
    const target = await signUp(a, "wildan");
    const read = () =>
      a.request("/users/me/notifications/read", { method: "POST", headers: authed(target) });

    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
  });

  it.each([
    ["GET", "/users/me/notifications"],
    ["POST", "/users/me/notifications/read"],
  ])("%s requires auth — 401", async (method, path) => {
    expect((await app().request(path, { method })).status).toBe(401);
  });

  it("one person's notifications are never another's", async () => {
    const a = app();
    const target = await signUp(a, "wildan");
    const bystander = await signUp(a, "budi");
    const follower = await signUp(a, "rina");

    await a.request("/users/wildan/follow", { method: "POST", headers: authed(follower) });

    expect((await (await bell(a, target)).json()).unreadCount).toBe(1);
    expect((await (await bell(a, bystander)).json()).unreadCount).toBe(0);
  });
});
