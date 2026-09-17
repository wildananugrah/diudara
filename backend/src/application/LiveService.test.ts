import { describe, expect, test } from "bun:test";
import { LiveService } from "./LiveService.ts";
import { AccessPolicy } from "./AccessPolicy.ts";
import type { LiveRepository, MembershipRepository } from "../domain/ports.ts";
import type { MemberRole } from "../domain/types.ts";

type Session = {
  id: string; communityId: string; streamKey: string; status: string; publishSecret: string | null;
};

/** What the deployment's MediaMTX is reachable at — injected, never read from env here. */
const RTMP_BASE = "rtmp://diudara2.mhamzah.id:1935";

/** Only "goodkey123" was ever issued, so every other key is a stale publish. */
function makeService(options: {
  role?: MemberRole | null;
  session?: Session | null;
  watchTokens?: Array<[string, { sessionId: string; userId: string; expiresAt: Date }]>;
} = {}) {
  const calls: Array<{ op: string; key: string }> = [];
  // The one row a community's live room is. `null` means the community has
  // never had one, which is what an admin opening the panel first time sees.
  let session = options.session === undefined
    ? {
        id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123",
        status: "idle", publishSecret: "rightsecret",
      }
    : options.session;
  const watchTokens = new Map<string, { sessionId: string; userId: string; expiresAt: Date }>(
    options.watchTokens ?? [],
  );

  const live = {
    findLatestForCommunity: async (communityId: string) => {
      calls.push({ op: "findLatest", key: communityId });
      return session;
    },
    createForCommunity: async (input: { communityId: string; streamKey: string; publishSecret: string }) => {
      calls.push({ op: "create", key: input.streamKey });
      session = {
        id: "sess-new", communityId: input.communityId, streamKey: input.streamKey,
        status: "idle", publishSecret: input.publishSecret,
      };
      return session;
    },
    rotateStreamKey: async (sessionId: string, streamKey: string, publishSecret: string) => {
      calls.push({ op: "rotate", key: streamKey });
      session = { ...session!, id: sessionId, streamKey, publishSecret };
    },
    startByStreamKey: async (key: string) => {
      calls.push({ op: "start", key });
      return key === "goodkey123";
    },
    endByStreamKey: async (key: string) => {
      calls.push({ op: "end", key });
      if (session) session = { ...session, status: "ended" };
      return key === "goodkey123";
    },
    findByStreamKey: async (key: string) => {
      calls.push({ op: "find", key });
      return session && session.streamKey === key
        ? { id: session.id, communityId: session.communityId, publishSecret: session.publishSecret }
        : null;
    },
    findActiveForCommunity: async () =>
      session && session.status === "live"
        ? { id: session.id, communityId: session.communityId, streamKey: session.streamKey,
            title: "Live", status: session.status, viewerCount: 0, startedAt: null }
        : null,
    createWatchToken: async (input: { token: string; sessionId: string; userId: string; expiresAt: Date }) => {
      calls.push({ op: "mintToken", key: input.token });
      watchTokens.set(input.token, { sessionId: input.sessionId, userId: input.userId, expiresAt: input.expiresAt });
    },
    touchViewer: async (sessionId: string, userId: string) => {
      calls.push({ op: "touchViewer", key: `${sessionId}:${userId}` });
    },
    deleteWatchTokensForSession: async (sessionId: string) => {
      calls.push({ op: "revokeTokens", key: sessionId });
      for (const [token, row] of watchTokens) if (row.sessionId === sessionId) watchTokens.delete(token);
    },
    findWatchToken: async (token: string) => {
      const row = watchTokens.get(token);
      return row ? { ...row, streamKey: session?.streamKey ?? "" } : null;
    },
    deleteExpiredWatchTokens: async () => { calls.push({ op: "prune", key: "" }); },
  } as unknown as LiveRepository;

  const memberships = {
    find: async () => (options.role ? { role: options.role, status: "active" } : null),
  } as unknown as MembershipRepository;
  return {
    service: new LiveService(live, new AccessPolicy(memberships), RTMP_BASE),
    calls,
    currentSession: () => session,
  };
}

describe("handleLifecycle", () => {
  test("online flips the session live; offline ends it", async () => {
    const { service, calls } = makeService();
    await expect(service.handleLifecycle("online", "c/goodkey123"))
      .resolves.toEqual({ ok: true, hook: "online", matched: true });
    await expect(service.handleLifecycle("offline", "c/goodkey123"))
      .resolves.toEqual({ ok: true, hook: "offline", matched: true });
    expect(calls).toEqual([
      { op: "start", key: "goodkey123" },
      { op: "end", key: "goodkey123" },
    ]);
  });

  test("an unknown key is a 200 no-op, not an error", async () => {
    // A non-2xx would make MediaMTX retry a hook that can never succeed, so the
    // miss is reported in the body instead.
    const { service } = makeService();
    await expect(service.handleLifecycle("online", "c/unknownkey1"))
      .resolves.toEqual({ ok: true, hook: "online", matched: false });
  });

  test("a foreign namespace throws, so a stale config is loud", async () => {
    // The hooks fire for `all_others`, so paths that are nothing to do with us
    // reach this endpoint. Those must not look like a healthy broadcast.
    const { service, calls } = makeService();
    for (const path of ["u/goodkey123", "live/goodkey123", "goodkey123", "c/bad", ""]) {
      await expect(service.handleLifecycle("online", path)).rejects.toThrow(/tidak dikenali/i);
    }
    expect(calls).toEqual([]);
  });

  test("an unrecognised hook is rejected before touching the database", async () => {
    const { service, calls } = makeService();
    for (const hook of ["", "READY", "start", "unpublish"]) {
      await expect(service.handleLifecycle(hook, "c/goodkey123")).rejects.toThrow(/Hook tidak dikenali/);
    }
    expect(calls).toEqual([]);
  });

  test("a path cannot escape the namespace", async () => {
    const { service, calls } = makeService();
    await expect(service.handleLifecycle("online", "c/goodkey123/../../etc")).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("authorise", () => {
  // MediaMTX asks this before it accepts a single frame. Any 2xx allows, so the
  // decision below is the only thing standing between a scanner on :1935 and a
  // community's broadcast path.

  test("allows a publish that presents the room's secret", async () => {
    const { service } = makeService();
    await expect(service.authorise({
      action: "publish", path: "c/goodkey123", user: "diudara", password: "rightsecret",
    })).resolves.toEqual({
      allow: true, action: "publish", streamKey: "goodkey123", communityId: "bimbel-sbmptn",
    });
  });

  test("refuses a publish carrying the wrong secret, or none at all", async () => {
    // The key travels in every viewer's HLS url, so it cannot be the credential.
    const { service } = makeService();
    for (const password of ["wrongsecret", "", undefined]) {
      await expect(service.authorise({ action: "publish", path: "c/goodkey123", password }))
        .resolves.toEqual({ allow: false, action: "publish", reason: "bad_publish_secret" });
    }
  });

  test("refuses a publish to a room that has no secret yet", async () => {
    // A room provisioned before secrets existed. No secret means no broadcasting,
    // never "anything matches".
    const { service } = makeService({
      session: {
        id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123",
        status: "idle", publishSecret: null,
      },
    });
    for (const password of ["", "anything", undefined]) {
      await expect(service.authorise({ action: "publish", path: "c/goodkey123", password }))
        .resolves.toEqual({ allow: false, action: "publish", reason: "bad_publish_secret" });
    }
  });

  test("refuses a publish to a key no session holds", async () => {
    // Shape alone is not authorisation: a key exists only because we issued it.
    const { service } = makeService();
    await expect(service.authorise({ action: "publish", path: "c/unknownkey1" })).resolves.toEqual({
      allow: false, action: "publish", reason: "unknown_stream_key",
    });
  });

  test("refuses a path outside our namespace without touching the database", async () => {
    const { service, calls } = makeService();
    for (const path of ["u/goodkey123", "live/goodkey123", "goodkey123", "c/bad", "c/goodkey123/../x", ""]) {
      await expect(service.authorise({ action: "publish", path })).resolves.toEqual({
        allow: false, action: "publish", reason: "unknown_path",
      });
    }
    expect(calls).toEqual([]);
  });

  test("refuses every action other than publish and read", async () => {
    // api/metrics/pprof are excluded from HTTP auth in mediamtx.yml and disabled
    // besides, so one arriving here means the config changed under us.
    const { service, calls } = makeService();
    for (const action of ["api", "metrics", "pprof", "playback", "PUBLISH", ""]) {
      await expect(service.authorise({ action, path: "c/goodkey123" })).resolves.toEqual({
        allow: false, action, reason: "unsupported_action",
      });
    }
    expect(calls).toEqual([]);
  });

  test("refuses a read that carries no watch token", async () => {
    const { service } = makeService();
    await expect(service.authorise({ action: "read", path: "c/goodkey123", query: "" }))
      .resolves.toEqual({ allow: false, action: "read", reason: "missing_watch_token" });
  });

  test("refuses an unknown watch token", async () => {
    const { service } = makeService();
    await expect(service.authorise({ action: "read", path: "c/goodkey123", query: "token=nope" }))
      .resolves.toEqual({ allow: false, action: "read", reason: "unknown_watch_token" });
  });

  test("refuses an expired watch token", async () => {
    const { service } = makeService({
      watchTokens: [["stale", { sessionId: "sess-1", userId: "u9", expiresAt: new Date(Date.now() - 1000) }]],
    });
    await expect(service.authorise({ action: "read", path: "c/goodkey123", query: "token=stale" }))
      .resolves.toEqual({ allow: false, action: "read", reason: "expired_watch_token" });
  });

  test("allows a read that presents a live watch token, and names the viewer", async () => {
    const { service } = makeService({
      watchTokens: [["fresh", { sessionId: "sess-1", userId: "u9", expiresAt: new Date(Date.now() + 60_000) }]],
    });
    // MediaMTX rewrites playlist urls to carry the query through, so the token
    // arrives on child playlists and segments too — captured from a real read.
    await expect(service.authorise({
      action: "read", path: "c/goodkey123", query: "cookieCheck=1&token=fresh",
    })).resolves.toEqual({
      allow: true, action: "read", streamKey: "goodkey123", communityId: "bimbel-sbmptn", userId: "u9",
    });
  });

});

describe("streamCredentials", () => {
  test("is refused to a member who is not an admin", async () => {
    // The panel is a broadcast credential, not a page decoration.
    const { service, calls } = makeService({ role: "member" });
    await expect(service.streamCredentials("bimbel-sbmptn", "u1")).rejects.toThrow(/admin/i);
    expect(calls).toEqual([]);
  });

  test("hands an admin the OBS-shaped fields for an existing room", async () => {
    const { service } = makeService({ role: "admin" });
    await expect(service.streamCredentials("bimbel-sbmptn", "u1")).resolves.toEqual({
      sessionId: "sess-1",
      streamKey: "goodkey123",
      publishSecret: "rightsecret",
      // OBS concatenates Server + "/" + Stream Key, so the credential rides in the
      // Stream Key field as a query — verified against a real RTMP publish.
      serverUrl: `${RTMP_BASE}/c`,
      obsStreamKey: "goodkey123?user=diudara&pass=rightsecret",
      ingestUrl: `${RTMP_BASE}/c/goodkey123?user=diudara&pass=rightsecret`,
      status: "idle",
    });
  });

  test("provisions the room the first time, then keeps that key", async () => {
    const { service, calls } = makeService({ role: "owner", session: null });
    const first = await service.streamCredentials("bimbel-sbmptn", "u1");
    expect(first.streamKey).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(calls.some((c) => c.op === "create")).toBe(true);

    // Opening the panel again must NOT mint a new key — that would break the
    // OBS profile the creator just configured.
    const second = await service.streamCredentials("bimbel-sbmptn", "u1");
    expect(second.streamKey).toBe(first.streamKey);
    expect(calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  test("mints a secret for a room provisioned before secrets existed", async () => {
    // Otherwise the creator sees a room they are not allowed to broadcast to.
    const { service } = makeService({
      role: "admin",
      session: {
        id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123",
        status: "idle", publishSecret: null,
      },
    });
    const creds = await service.streamCredentials("bimbel-sbmptn", "u1");
    expect(creds.publishSecret).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    // The key is what OBS and viewers already know; only the missing half is added.
    expect(creds.streamKey).toBe("goodkey123");
  });
});

describe("rotateStreamKey", () => {
  test("is refused to a member who is not an admin", async () => {
    const { service, calls } = makeService({ role: "member" });
    await expect(service.rotateStreamKey("bimbel-sbmptn", "u1")).rejects.toThrow(/admin/i);
    expect(calls).toEqual([]);
  });

  test("replaces the key, so the old one stops working on the next connect", async () => {
    const { service } = makeService({ role: "admin" });
    const rotated = await service.rotateStreamKey("bimbel-sbmptn", "u1");
    expect(rotated.streamKey).not.toBe("goodkey123");
    expect(rotated.streamKey).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    // BOTH halves move. Rotating the public key while leaving the secret would
    // revoke nothing that mattered.
    expect(rotated.publishSecret).not.toBe("rightsecret");
    expect(rotated.ingestUrl).toBe(
      `${RTMP_BASE}/c/${rotated.streamKey}?user=diudara&pass=${rotated.publishSecret}`,
    );
  });

  test("ends a session that was live, because the old path can no longer match", async () => {
    // MediaMTX asks for authorisation once, at connect. A rotation mid-broadcast
    // leaves the publisher streaming under the OLD path, whose offline hook would
    // then find no session and leave this row stuck `live` forever.
    const { service, currentSession } = makeService({
      role: "admin",
      session: {
        id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123",
        status: "live", publishSecret: "rightsecret",
      },
    });
    const rotated = await service.rotateStreamKey("bimbel-sbmptn", "u1");
    expect(rotated.endedActiveSession).toBe(true);
    expect(currentSession()!.status).toBe("ended");
  });

  test("revokes every outstanding watch token", async () => {
    // Otherwise a token minted a minute ago keeps working against the NEW key:
    // it resolves through the session row, whose key has just moved under it.
    const { service } = makeService({
      role: "admin",
      watchTokens: [["issued", { sessionId: "sess-1", userId: "u9", expiresAt: new Date(Date.now() + 60_000) }]],
    });
    const rotated = await service.rotateStreamKey("bimbel-sbmptn", "u1");
    await expect(service.authorise({
      action: "read", path: `c/${rotated.streamKey}`, query: "token=issued",
    })).resolves.toEqual({ allow: false, action: "read", reason: "unknown_watch_token" });
  });

  test("says so when there was no live session to end", async () => {
    const { service } = makeService({ role: "admin" });
    await expect(service.rotateStreamKey("bimbel-sbmptn", "u1")).resolves.toMatchObject({
      endedActiveSession: false,
    });
  });

  test("provisions a room for a community that never had one", async () => {
    const { service, calls } = makeService({ role: "admin", session: null });
    const rotated = await service.rotateStreamKey("bimbel-sbmptn", "u1");
    expect(rotated.streamKey).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(calls.some((c) => c.op === "create")).toBe(true);
  });
});

describe("watchToken", () => {
  test("is refused to someone who is not an active member", async () => {
    const { service } = makeService({
      role: null,
      session: { id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123", status: "live", publishSecret: "s" },
    });
    await expect(service.watchToken("bimbel-sbmptn", "u9")).rejects.toThrow(/anggota/i);
  });

  test("refuses when nothing is on air — there is nothing to authorise", async () => {
    const { service } = makeService({ role: "member" });
    await expect(service.watchToken("bimbel-sbmptn", "u9")).rejects.toThrow(/Sesi live/);
  });

  test("persists the token it hands out, with a playback url the player can use", async () => {
    const { service, calls } = makeService({
      role: "member",
      session: { id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123", status: "live", publishSecret: "s" },
    });
    const issued = await service.watchToken("bimbel-sbmptn", "u9");

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(issued.playbackUrl).toBe(`/hls/c/goodkey123/index.m3u8?token=${issued.token}`);
    expect(issued.expiresInSeconds).toBeGreaterThan(0);
    // Persisted, not invented: the old implementation returned a random UUID it
    // never stored, so /auth had nothing to check it against.
    expect(calls.some((c) => c.op === "mintToken" && c.key === issued.token)).toBe(true);

    await expect(service.authorise({
      action: "read", path: "c/goodkey123", query: `token=${issued.token}`,
    })).resolves.toMatchObject({ allow: true, userId: "u9" });
  });

  test("prunes expired tokens when it mints one", async () => {
    const { service, calls } = makeService({
      role: "member",
      session: { id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123", status: "live", publishSecret: "s" },
    });
    await service.watchToken("bimbel-sbmptn", "u9");
    expect(calls.some((c) => c.op === "prune")).toBe(true);
  });
});

describe("heartbeat", () => {
  const liveRoom = {
    id: "sess-1", communityId: "bimbel-sbmptn", streamKey: "goodkey123",
    status: "live", publishSecret: "s",
  };

  test("records the viewer as present", async () => {
    // This IS the viewer count. Before it, the number came from a column nobody
    // ever incremented — 128 forever, straight from the seed.
    const { service, calls } = makeService({ role: "member", session: liveRoom });
    await expect(service.heartbeat("bimbel-sbmptn", "u9")).resolves.toEqual({ ok: true });
    expect(calls).toContainEqual({ op: "touchViewer", key: "sess-1:u9" });
  });

  test("is refused to someone who is not an active member", async () => {
    const { service, calls } = makeService({ role: null, session: liveRoom });
    await expect(service.heartbeat("bimbel-sbmptn", "u9")).rejects.toThrow(/anggota/i);
    expect(calls.some((c) => c.op === "touchViewer")).toBe(false);
  });

  test("refuses when nothing is on air, so presence cannot outlive the session", async () => {
    const { service } = makeService({ role: "member" });
    await expect(service.heartbeat("bimbel-sbmptn", "u9")).rejects.toThrow(/Sesi live/);
  });
});
