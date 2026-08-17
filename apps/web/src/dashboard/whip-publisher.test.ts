import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publishToWhip, WhipNegotiationError } from "./whip-publisher";

/**
 * A video transceiver, modelling only what `preferH264` touches. Records
 * whatever codec list it is handed so a test can assert the ORDER, which is
 * the entire contract `setCodecPreferences` has.
 */
class FakeTransceiver {
  preferences: { mimeType: string }[] | null = null;
  constructor(public readonly kind: string) {}
  setCodecPreferences(codecs: { mimeType: string }[]) {
    this.preferences = codecs;
  }
}

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
  transceivers: FakeTransceiver[] = [];
  protected listeners = new Map<string, Set<() => void>>();

  addTrack(track: unknown) {
    this.tracks.push(track);
    this.transceivers.push(new FakeTransceiver((track as { kind?: string }).kind ?? "video"));
  }

  getTransceivers() {
    return this.transceivers;
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
  constructor(public readonly kind: string = "video") {}
  stop() {
    this.stopped = true;
  }
}

function fakeStream(): MediaStream {
  const tracks = [new FakeTrack("video"), new FakeTrack("audio")];
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/**
 * Stands in for `RTCRtpSender.getCapabilities("video")`, in the order a real
 * Chromium actually reports — VP8 FIRST, which is precisely the problem
 * `preferH264` exists to solve. Installed/removed per test rather than
 * globally, because most tests in this file must keep exercising the
 * "browser has no codec-preference API at all" path.
 */
function installVideoCapabilities(mimeTypes: string[]) {
  (globalThis as Record<string, unknown>).RTCRtpSender = {
    getCapabilities: (kind: string) =>
      kind === "video" ? { codecs: mimeTypes.map((mimeType) => ({ mimeType })) } : null,
  };
}

let originalRTCPeerConnection: unknown;
let originalRTCRtpSender: unknown;

beforeEach(() => {
  originalRTCPeerConnection = (globalThis as Record<string, unknown>).RTCPeerConnection;
  originalRTCRtpSender = (globalThis as Record<string, unknown>).RTCRtpSender;
  (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).RTCPeerConnection = originalRTCPeerConnection;
  (globalThis as Record<string, unknown>).RTCRtpSender = originalRTCRtpSender;
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

/**
 * TASK 4 (the phase gate) — THE DEFECT THAT MADE EVERY MEMBER'S PLAYER BLACK.
 *
 * Found by actually opening the member watch page against a real browser
 * publish, which nothing before this task had done. Chromium's default video
 * codec preference is VP8, so that is what the WHIP offer asked for and what
 * MediaMTX accepted. MediaMTX's own log for that publish:
 *
 *   INF [path live/<key>] stream is available and online, 2 tracks (Opus, VP8)
 *   WAR [HLS] [muxer live/<key>] skipping track 2 (VP8)
 *   INF [HLS] [muxer live/<key>] is converting into HLS, 1 track (Opus)
 *
 * HLS cannot carry VP8, so MediaMTX silently DROPPED the video and served the
 * members an audio-only stream. Measured on the member's real `<video>`
 * element: `readyState: 4`, `paused: false`, `currentTime` genuinely
 * advancing — and `videoWidth: 0, videoHeight: 0`. Everything looked healthy
 * from every angle except the one that matters: there was no picture.
 *
 * Nothing about this is visible from the publishing side (the creator's own
 * preview is the local camera, not the round trip), and neither MediaMTX nor
 * the API reports an error — the `WAR` above is the only signal anywhere.
 *
 * RTMP/OBS was never affected: ffmpeg publishes H264, which HLS carries.
 * That is why this survived the whole live-streaming phase and only surfaced
 * once browsers became publishers.
 */
describe("publishToWhip video codec preference", () => {
  it("asks for H264 first, so MediaMTX's HLS muxer can carry the video", async () => {
    // The order a real Chromium reports — VP8 first.
    installVideoCapabilities(["video/VP8", "video/rtx", "video/H264", "video/AV1", "video/VP9"]);
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };

    await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });

    const video = capturedPc!.getTransceivers().find((t) => t.kind === "video");
    expect(video).toBeDefined();
    expect(video!.preferences).not.toBe(null);
    expect(video!.preferences![0].mimeType).toBe("video/H264");
    // Everything else is still offered — H264 is a PREFERENCE, not a
    // restriction. A server that cannot do H264 must still be able to pick
    // something rather than failing to negotiate any video at all.
    expect(video!.preferences!.map((c) => c.mimeType)).toContain("video/VP8");
    expect(video!.preferences!.length).toBe(5);
  });

  it("leaves the audio transceiver's codecs alone", async () => {
    installVideoCapabilities(["video/VP8", "video/H264"]);
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };

    await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });

    const audio = capturedPc!.getTransceivers().find((t) => t.kind === "audio");
    expect(audio!.preferences).toBe(null);
  });

  it("publishes anyway when the browser reports no H264 support at all", async () => {
    // No H264 in the list — an unusual browser, or one built without it.
    // Reordering is impossible, and refusing to publish over it would be a
    // far worse outcome than a video track HLS happens not to carry.
    installVideoCapabilities(["video/VP8", "video/VP9"]);
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends FakePeerConnection {
      constructor() {
        super();
        capturedPc = this;
      }
    };

    const handle = await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
    });

    expect(handle).toBeDefined();
    expect(capturedPc!.getTransceivers().find((t) => t.kind === "video")!.preferences).toBe(null);
  });

  it("publishes anyway on a browser with no codec-preference API", async () => {
    // `RTCRtpSender.getCapabilities` and `setCodecPreferences` are both
    // absent here (nothing installed by this test) — older Safari/Firefox.
    // The publish must still work; only the preference is lost.
    const handle = await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
    });
    expect(handle).toBeDefined();
  });
});

/**
 * TASK (Fix Round 3) — THE DEFECT MEASURED IN PRODUCTION, on
 * `diudara.mhamzah.id`: a creator published from Firefox, the UI showed
 * "Hentikan siaran" and the don't-close-this-tab warning (every signal Fix
 * Rounds 1 and 2 above check said this was a healthy publish), while
 * MediaMTX's own log read `stream is available and online, 1 track (Opus)`
 * — audio only. Firefox's H264 encoder depends on Cisco's OpenH264 being
 * present; without it (and without a server-side codec Firefox can actually
 * encode either), a video transceiver can report "connected" while producing
 * zero RTP packets, forever. Nothing before this fix ever checked that VIDEO
 * specifically was moving.
 *
 * `verifyVideoIsFlowing` is feature-detected via `getSenders`/`getStats`
 * exactly like `preferH264` is via `getCapabilities`/`setCodecPreferences` —
 * every test above this block uses the plain `FakePeerConnection`, which has
 * neither method, and every one of those tests still passes after this fix:
 * that IS the regression coverage for "a browser without this API publishes
 * exactly as it did before."
 */
describe("publishToWhip video-flow verification (Fix Round 3)", () => {
  /**
   * A minimal `RTCRtpSender` stand-in: a `track` (or `null`, modelling "no
   * video sender exists") and a `getStats()` that hands back a real `Map`,
   * matching `RTCStatsReport`'s own Map-like shape (see `outboundBytesSent`'s
   * own docstring on why a plain object would not do). `bytesSentSequence`
   * lets a test model bytes ramping up over successive polls — the LAST
   * value repeats once the sequence is exhausted, so a test can express
   * "starts at 0, then flows" without listing every poll it might take.
   */
  class FakeVideoSender {
    calls = 0;
    constructor(
      public track: { kind: string } | null,
      private bytesSentSequence: number[]
    ) {}
    async getStats() {
      const index = Math.min(this.calls, this.bytesSentSequence.length - 1);
      this.calls += 1;
      return new Map([["outbound-rtp-video", { type: "outbound-rtp", bytesSent: this.bytesSentSequence[index] }]]);
    }
  }

  /** A `FakePeerConnection` whose `getSenders()` is controlled per test, unlike the plain base class. */
  function peerConnectionWithSenders(getSenders: () => { track: { kind: string } | null; getStats?: () => Promise<Map<string, unknown>> }[]) {
    return class extends FakePeerConnection {
      getSenders() {
        return getSenders();
      }
    };
  }

  it("throws a message naming Firefox when the video sender's bytesSent stays at zero (the actual production defect)", async () => {
    const sender = new FakeVideoSender({ kind: "video" }, [0]);
    (globalThis as Record<string, unknown>).RTCPeerConnection = peerConnectionWithSenders(() => [sender]);

    try {
      await publishToWhip({
        whipUrl: WHIP_URL,
        stream: fakeStream(),
        fetchFn: okAnswer(),
        videoFlowTimeoutMs: 20,
        videoFlowPollIntervalMs: 5,
      });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      const message = (err as Error).message;
      expect(message).toContain("Firefox");
      expect(message).toContain("OBS");
      expect(message).not.toContain("ReferenceError");
    }
  });

  it("closes the peer connection when video never starts sending (not left open as a ghost audio-only publish)", async () => {
    const sender = new FakeVideoSender({ kind: "video" }, [0]);
    let capturedPc: FakePeerConnection | undefined;
    (globalThis as Record<string, unknown>).RTCPeerConnection = class extends (
      peerConnectionWithSenders(() => [sender])
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
        videoFlowTimeoutMs: 20,
        videoFlowPollIntervalMs: 5,
      });
    } catch {
      // expected
    }

    expect(capturedPc?.closed).toBe(true);
  });

  it("throws a DIFFERENT message, not naming Firefox, when no video sender was negotiated at all", async () => {
    // Only an audio sender — models a stream with no video track at all, so
    // there was never anything for the server to accept in the first place.
    (globalThis as Record<string, unknown>).RTCPeerConnection = peerConnectionWithSenders(() => [
      { track: { kind: "audio" }, getStats: async () => new Map() },
    ]);

    try {
      await publishToWhip({
        whipUrl: WHIP_URL,
        stream: fakeStream(),
        fetchFn: okAnswer(),
        videoFlowTimeoutMs: 20,
        videoFlowPollIntervalMs: 5,
      });
      throw new Error("expected publishToWhip to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WhipNegotiationError);
      const message = (err as Error).message;
      // Distinct wording from the "sends nothing" case above: this browser
      // never had video to send, so blaming Firefox's encoder specifically
      // would be a wrong diagnosis.
      expect(message).not.toContain("Firefox");
      expect(message).toContain("OBS");
    }
  });

  it("does NOT wait out the poll timeout when there is no video sender at all (fails fast)", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = peerConnectionWithSenders(() => [
      { track: { kind: "audio" }, getStats: async () => new Map() },
    ]);
    const startedAt = Date.now();

    try {
      await publishToWhip({
        whipUrl: WHIP_URL,
        stream: fakeStream(),
        fetchFn: okAnswer(),
        videoFlowTimeoutMs: 5_000, // would take 5s to fail if this waited the timeout out
        videoFlowPollIntervalMs: 5,
      });
    } catch {
      // expected
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("resolves normally once the video sender's outbound bytesSent becomes nonzero on a later poll", async () => {
    // Starts at 0 (mirroring a real encoder's brief startup) and ramps up —
    // proves this is genuinely POLLING for the transition, not just reading
    // one snapshot immediately after "connected".
    const sender = new FakeVideoSender({ kind: "video" }, [0, 0, 48_000]);
    (globalThis as Record<string, unknown>).RTCPeerConnection = peerConnectionWithSenders(() => [sender]);

    const handle = await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
      videoFlowTimeoutMs: 1_000,
      videoFlowPollIntervalMs: 5,
    });

    expect(handle.close).toBeInstanceOf(Function);
    expect(sender.calls).toBeGreaterThanOrEqual(3);
  });

  it("treats a getStats() that throws as unverifiable, not as evidence of failure", async () => {
    const sender = {
      track: { kind: "video" },
      getStats: async () => {
        throw new Error("getStats is not implemented in this environment");
      },
    };
    (globalThis as Record<string, unknown>).RTCPeerConnection = peerConnectionWithSenders(() => [sender]);

    const handle = await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
      videoFlowTimeoutMs: 20,
      videoFlowPollIntervalMs: 5,
    });

    expect(handle.close).toBeInstanceOf(Function);
  });

  it("treats a video sender with no getStats() at all as unverifiable, not as evidence of failure", async () => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = peerConnectionWithSenders(() => [
      { track: { kind: "video" } },
    ]);

    const handle = await publishToWhip({
      whipUrl: WHIP_URL,
      stream: fakeStream(),
      fetchFn: okAnswer(),
      videoFlowTimeoutMs: 20,
      videoFlowPollIntervalMs: 5,
    });

    expect(handle.close).toBeInstanceOf(Function);
  });

  it("skips the whole check when getSenders is unavailable — every earlier test in this file relies on exactly this", async () => {
    // `FakePeerConnection` (installed in `beforeEach`) has no `getSenders`,
    // matching a real browser without the newer WebRTC stats API. This test
    // exists to say so explicitly; every OTHER test in this file is already
    // proof this path keeps working.
    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn: okAnswer() });
    expect(handle.close).toBeInstanceOf(Function);
  });
});
