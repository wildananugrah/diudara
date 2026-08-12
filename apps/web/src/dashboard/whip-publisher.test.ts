import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publishToWhip, WhipNegotiationError } from "./whip-publisher";

/**
 * A fake `RTCPeerConnection`, installed on `globalThis` before each test —
 * this module's whole point (see its own docstring) is that the negotiation
 * logic is testable WITHOUT a real browser's WebRTC stack, only with
 * `fetchFn` and this fake standing in for what a real browser provides.
 * `iceGatheringState` starts `"complete"` so `waitForIceGathering` resolves
 * on its synchronous fast path — a real gathering delay is exactly what
 * `ICE_GATHERING_TIMEOUT_MS` exists to bound, and is not this module's own
 * logic to re-test here.
 */
class FakePeerConnection {
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  iceGatheringState = "complete";
  closed = false;
  tracks: unknown[] = [];

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
  }

  addEventListener() {
    // iceGatheringState is already "complete" — waitForIceGathering never
    // registers a listener that needs to fire.
  }

  removeEventListener() {}

  close() {
    this.closed = true;
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

  it("close() never throws even when the best-effort DELETE fails", async () => {
    const fetchFn = async (url: string, init: RequestInit) => {
      if (init.method === "DELETE") throw new Error("network down");
      return okAnswer()(url, init);
    };

    const handle = await publishToWhip({ whipUrl: WHIP_URL, stream: fakeStream(), fetchFn });

    expect(() => handle.close()).not.toThrow();
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
