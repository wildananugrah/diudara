import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publishToWhip, WhipNegotiationError } from "./whip-publisher";

/**
 * A fake `RTCPeerConnection`, installed on `globalThis` before each test —
 * this module's whole point (see its own docstring) is that the negotiation
 * logic is testable WITHOUT a real browser's WebRTC stack, only with
 * `fetchFn` and this fake standing in for what a real browser provides.
 *
 * `connectionState` starts `"new"` and `setRemoteDescription` transitions it
 * to `"connected"` BY DEFAULT (`autoConnect = true`) — a real successful
 * negotiation reaches "connected" shortly after the answer is applied, and
 * most tests here are not testing that transition itself, only what
 * `publishToWhip` does once it happens. The two subclasses below
 * (`NeverConnectingPeerConnection`, `FailingPeerConnection`) override this to
 * exercise Fix Round 1's Critical 1: signalling succeeding is NOT the same
 * as the connection actually coming up.
 */
class FakePeerConnection {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceGatheringState = "complete";
  connectionState = "new";
  closed = false;
  tracks: unknown[] = [];
  protected listeners = new Map<string, Set<() => void>>();

  addTrack(track: unknown) {
    this.tracks.push(track);
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0\r\no=- fake-offer\r\n" };
  }

  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this._setConnectionState("connected");
  }

  addEventListener(event: string, callback: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  }

  removeEventListener(event: string, callback: () => void) {
    this.listeners.get(event)?.delete(callback);
  }

  /** Simulates a real browser transitioning `connectionState` and firing the event. */
  _setConnectionState(state: string) {
    this.connectionState = state;
    for (const callback of this.listeners.get("connectionstatechange") ?? []) callback();
  }

  close() {
    this.closed = true;
  }
}

/** Signalling succeeds, but ICE never connects — the UDP-blocked-network case. */
class NeverConnectingPeerConnection extends FakePeerConnection {
  override async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    // Deliberately does NOT call `_setConnectionState` — `connectionState`
    // stays "new" forever, exactly like a real peer connection whose ICE
    // checks never succeed.
  }
}

/** Signalling succeeds, but the peer connection reports `"failed"`. */
class FailingPeerConnection extends FakePeerConnection {
  override async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
    this._setConnectionState("failed");
  }
}

/**
 * Models a browser whose `RTCPeerConnection` has NO `connectionState` field
 * at all — older Firefox, older Safari (Fix Round 2, N4). Deliberately does
 * NOT extend `FakePeerConnection`: that class's own `connectionState: string`
 * field cannot be narrowed to `string | undefined` in a subclass under
 * strict TS, and a real legacy browser's object genuinely lacks the
 * property rather than setting it `undefined`, which is what omitting it
 * here reproduces. `iceConnectionState`/`iceconnectionstatechange` are what
 * such a browser exposes instead, and are the ONLY state signal this class
 * ever fires.
 */
class LegacyPeerConnection {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceGatheringState = "complete";
  iceConnectionState = "new";
  closed = false;
  private listeners = new Map<string, Set<() => void>>();

  addTrack() {}
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\no=- fake-offer\r\n" };
  }
  async setLocalDescription(desc: { type: string; sdp: string }) {
    this.localDescription = desc;
  }
  /** Subclasses decide what (if anything) `iceConnectionState` does next. */
  async setRemoteDescription(desc: { type: string; sdp: string }) {
    this.remoteDescription = desc;
  }
  addEventListener(event: string, callback: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(callback);
  }
  removeEventListener(event: string, callback: () => void) {
    this.listeners.get(event)?.delete(callback);
  }
  _setIceConnectionState(state: string) {
    this.iceConnectionState = state;
    for (const callback of this.listeners.get("iceconnectionstatechange") ?? []) callback();
  }
  close() {
    this.closed = true;
  }
}

/** A legacy connection that reaches "connected" (via iceConnectionState) a tick after the answer is applied. */
class LegacyConnectingPeerConnection extends LegacyPeerConnection {
  override async setRemoteDescription(desc: { type: string; sdp: string }) {
    await super.setRemoteDescription(desc);
    setTimeout(() => this._setIceConnectionState("connected"), 0);
  }
}

/** A legacy connection that reports "failed" (via iceConnectionState) a tick after the answer is applied. */
class LegacyFailingPeerConnection extends LegacyPeerConnection {
  override async setRemoteDescription(desc: { type: string; sdp: string }) {
    await super.setRemoteDescription(desc);
    setTimeout(() => this._setIceConnectionState("failed"), 0);
  }
}

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream(): MediaStream {
  const tracks = [new FakeTrack(), new FakeTrack()];
  return { getTracks: () => tracks } as unknown as MediaStream;
}

let originalRTCPeerConnection: unknown;

beforeEach(() => {
  originalRTCPeerConnection = (globalThis as Record<string, unknown>).RTCPeerConnection;
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).RTCPeerConnection = originalRTCPeerConnection;
});

const WHIP_URL = "https://stream.example.com/whip/streamkey123";

function okAnswer(location = "/whip/streamkey123/session-abc") {
  return async (_url: string, _init: RequestInit) =>
    new Response("v=0\r\no=- fake-answer\r\n", {
      status: 201,
      headers: { "Content-Type": "application/sdp", Location: location },
    });
}

describe("publishToWhip", () => {
  it("POSTs the local SDP offer with the right content type", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return okAnswer()(url, init);
    };

    await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });

    expect(calls[0].url).toBe(WHIP_URL);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/sdp"
    );
    expect(calls[0].init.body).toContain("fake-offer");
  });

  it("adds every track from the given stream to the peer connection", async () => {
    const stream = fakeStream();
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };

    await publishToWhip({ whipUrl: WHIP_URL, stream, fetchFn: okAnswer() });

    expect(capturedPc?.tracks.length).toBe(stream.getTracks().length);
  });

  it("applies the answer SDP as the remote description", async () => {
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };

    await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });

    expect(capturedPc?.remoteDescription?.sdp).toContain("fake-answer");
  });

  it("does not resolve until the peer connection actually reaches \"connected\"", async () => {
    // A connection that starts out NOT connected and only flips over on a
    // later event — proves publishToWhip is awaiting the real transition,
    // not just checking a snapshot.
    class ConnectsLatePeerConnection extends FakePeerConnection {
      override async setRemoteDescription(desc: { type: string; sdp: string }) {
        this.remoteDescription = desc;
        // A macrotask tick later, not a microtask — guarantees this runs
        // AFTER `waitForConnection` has already registered its listener
        // (which happens synchronously once `setRemoteDescription`'s own
        // promise settles), so this only passes if publishToWhip is
        // genuinely awaiting the event rather than resolving beforehand.
        setTimeout(() => this._setConnectionState("connected"), 0);
      }
    }
    (globalThis as Record<string, unknown>).RTCPeerConnection = ConnectsLatePeerConnection;

    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });
    expect(handle.close).toBeInstanceOf(Function);
  });

  it("resolves the session URL against whipUrl, then DELETEs it and closes the peer connection on close()", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      return okAnswer("/whip/streamkey123/session-abc")(url, init);
    };

    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });
    handle.close();
    // The DELETE fires from a fire-and-forget promise inside close() — give
    // the microtask queue one turn to run it before asserting.
    await Promise.resolve();
    await Promise.resolve();

    expect(capturedPc?.closed).toBe(true);
    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    expect(deleteCall?.url).toBe("https://stream.example.com/whip/streamkey123/session-abc");
  });

  it("pins the session URL to whipUrl's own origin even when Location is absolute with a foreign origin", async () => {
    // The real failure mode this guards: a proxy's `Location` rewrite
    // producing an absolute URL whose origin the browser never actually
    // reached (measured in Task 3's own real-browser verification, under a
    // Docker port-remapping arrangement). `new URL(location, whipUrl)`
    // ALONE would keep that foreign origin, because the URL constructor
    // ignores its base entirely once `location` is already absolute.
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      return okAnswer("http://internal-only-host:8443/whip/streamkey123/session-xyz?x=1")(
        url,
        init
      );
    };

    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });
    handle.close();
    await Promise.resolve();
    await Promise.resolve();

    const deleteCall = calls.find((c) => c.init.method === "DELETE");
    // Same origin as whipUrl (stream.example.com), NOT internal-only-host —
    // only the path+search survived the foreign Location.
    expect(deleteCall?.url).toBe(
      "https://stream.example.com/whip/streamkey123/session-xyz?x=1"
    );
  });

  it("close() never throws even when the best-effort DELETE fails", async () => {
    const fetchFn = async (url: string, init: RequestInit) => {
      if (init.method === "DELETE") throw new Error("network down");
      return okAnswer()(url, init);
    };

    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });

    expect(() => handle.close()).not.toThrow();
  });

  it("calls onDisconnected when the connection drops AFTER a successful publish", async () => {
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };
    let disconnectedCalls = 0;

    await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
      onDisconnected: () => {
        disconnectedCalls += 1;
      },
    });

    expect(disconnectedCalls).toBe(0);
    capturedPc?._setConnectionState("failed");
    expect(disconnectedCalls).toBe(1);
  });

  it("does NOT call onDisconnected for a stop the caller itself initiated via close()", async () => {
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };
    let disconnectedCalls = 0;

    const handle = await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
      onDisconnected: () => {
        disconnectedCalls += 1;
      },
    });

    handle.close();
    // A real browser fires connectionstatechange -> "closed" as a RESULT of
    // pc.close() too; the guard must hold even when that happens.
    capturedPc?._setConnectionState("closed");

    expect(disconnectedCalls).toBe(0);
  });

  it("throws a WhipNegotiationError naming the status when the server rejects the offer", async () => {
    const fetchFn = async () =>
      new Response("refused", { status: 401, headers: { "Content-Type": "text/plain" } });

    await expect(
      publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn })
    ).rejects.toThrow(WhipNegotiationError);

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      expect((err as Error).message).toContain("401");
    }
  });

  it("throws a WhipNegotiationError when the answer carries no Location header", async () => {
    const fetchFn = async () =>
      new Response("v=0\r\n", { status: 201, headers: { "Content-Type": "application/sdp" } });

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
    }
  });

  it("throws a WhipNegotiationError naming UDP and OBS when the request itself fails (e.g. a blocking network)", async () => {
    const fetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      const message = (err as Error).message;
      expect(message).toContain("UDP");
      expect(message).toContain("OBS");
    }
  });

  // CRITICAL 1 (fix round 1): signalling succeeding must NOT be treated as a
  // successful publish. These two pin the fix directly, per review's own
  // instruction: "a fake that never connects must produce the UDP message,
  // not a resolved handle".
  it("throws the SAME UDP/OBS message when ICE never connects (signalling succeeds, media never does)", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = NeverConnectingPeerConnection;

    try {
      await publishToWhip({
        whipUrl: WHIP_URL,
        stream: fakeStream(),
        fetchFn: okAnswer(),
        connectTimeoutMs: 20, // real value is 15s; kept fast for the test
      });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      const message = (err as Error).message;
      expect(message).toContain("UDP");
      expect(message).toContain("OBS");
    }
  });

  it("throws the UDP/OBS message when the peer connection reports \"failed\"", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = FailingPeerConnection;

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      const message = (err as Error).message;
      expect(message).toContain("UDP");
      expect(message).toContain("OBS");
    }
  });

  // FIX ROUND 2, N4: some RTCPeerConnection implementations (older Firefox,
  // Safari) never expose `connectionState` at all — reading it is always
  // `undefined`. Without a fallback, `waitForConnection` would wait out the
  // full timeout and report the UDP/OBS message on a publish that was
  // actually working, a false negative in the OPPOSITE direction from
  // Critical 1.
  it("falls back to iceConnectionState when connectionState is undefined, and still resolves on success", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = LegacyConnectingPeerConnection;

    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });

    expect(handle.close).toBeInstanceOf(Function);
  });

  it("falls back to iceConnectionState to detect a failure too, producing the same UDP/OBS message", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = LegacyFailingPeerConnection;

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      const message = (err as Error).message;
      expect(message).toContain("UDP");
      expect(message).toContain("OBS");
    }
  });

  // FIX ROUND 2, N2: a single real drop was measured firing TWO qualifying
  // transitions ("failed", then "closed") — `onDisconnected` must still
  // fire only once, because `EventsPage.tsx`'s own handler decrements a
  // SHARED, ref-counted unload-warning guard each time it runs (Fix Round 1,
  // Critical 2); a double call would wrongly silence that guard for a
  // DIFFERENT row that is still genuinely broadcasting.
  it("calls onDisconnected at most once per drop, even across two qualifying state transitions", async () => {
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };
    let disconnectedCalls = 0;

    await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
      onDisconnected: () => {
        disconnectedCalls += 1;
      },
    });

    capturedPc?._setConnectionState("failed");
    capturedPc?._setConnectionState("closed");

    expect(disconnectedCalls).toBe(1);
  });

  it("closes the peer connection when negotiation fails partway", async () => {
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };
    const fetchFn = async () => {
      throw new TypeError("Failed to fetch");
    };

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });
    } catch {
      // expected
    }

    expect(capturedPc?.closed).toBe(true);
  });

  it("closes the peer connection when ICE never connects (not left open as a ghost)", async () => {
    let capturedPc: NeverConnectingPeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends (
      NeverConnectingPeerConnection
    ) {
      constructor() {
        super();
        capturedPc = this;
      }
    };

    try {
      await publishToWhip({
        whipUrl: WHIP_URL,
        stream: fakeStream(),
        fetchFn: okAnswer(),
        connectTimeoutMs: 20,
      });
    } catch {
      // expected
    }

    expect(capturedPc?.closed).toBe(true);
  });

  it("throws an Indonesian message, not a raw ReferenceError, when RTCPeerConnection is unavailable", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = undefined;

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      expect((err as Error).message).toContain("WebRTC");
      expect((err as Error).message).not.toContain("ReferenceError");
    }
  });

  it("defaults fetchFn to the global fetch when none is injected", async () => {
    const originalFetch = global.fetch;
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okAnswer()("x", {});
    }) as unknown as typeof fetch;

    try {
      await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream() });
    } finally {
      global.fetch = originalFetch;
    }

    expect(called).toBe(true);
  });
});
