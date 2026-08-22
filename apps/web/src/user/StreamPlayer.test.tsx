import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import StreamPlayer, {
  defaultAttachHls,
  type AttachHls,
  type AttachHlsInput,
  type StreamPlayerHandle,
} from "./StreamPlayer";
import type { StreamView, WatchTokenResult } from "./apiClient";

afterEach(() => cleanup());

/**
 * `StreamPlayer` owns the re-mint loop — the task brief's own words: "a
 * player that mints once and never again works for ten minutes and then
 * fails SILENTLY." Every test here injects `attachHls` and `mintToken`
 * rather than touching real `hls.js` or a real network call, the identical
 * shape `WatchPage.test.tsx` uses for `attachPlayer` — happy-dom has no
 * `MediaSource`, so a real `hls.js` attach is not exercisable in this
 * environment at all, and none of this suite's own guarantees (mint order,
 * re-mint timing, cleanup) depend on `hls.js` internals.
 */

function unlockedStream(overrides: Partial<StreamView> = {}): StreamView {
  return {
    id: "stream-1",
    title: "Bedah karya",
    visibility: "members",
    owner: { handle: "wildan", displayName: "Wildan" },
    locked: false,
    hlsPlaybackPath: "/u/stream-1/index.m3u8",
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tokenResult(token: string): WatchTokenResult {
  return { token, expiresAt: "2026-01-01T00:10:00.000Z" };
}

/** A fake `attachHls` that records every call and every `getToken()` read, and hands the caller its own `destroy` spy. */
function recordingAttach(): {
  attach: AttachHls;
  calls: AttachHlsInput[];
  destroyCount: () => number;
  reportFatal: () => void;
} {
  const calls: AttachHlsInput[] = [];
  let destroyCount = 0;
  let lastOnFatalError: (() => void) | undefined;
  const attach: AttachHls = (input) => {
    calls.push(input);
    lastOnFatalError = input.onFatalError;
    return {
      destroy() {
        destroyCount += 1;
      },
    } satisfies StreamPlayerHandle;
  };
  return {
    attach,
    calls,
    destroyCount: () => destroyCount,
    reportFatal: () => lastOnFatalError?.(),
  };
}

/**
 * Fix round 1. A fake `attachHls` shaped like the NATIVE `<video src>`
 * branch of `defaultAttachHls` — its handle implements `onTokenRefreshed`,
 * unlike `recordingAttach()`'s hls.js-shaped handle above, which does not.
 * Records the token `getToken()` reads at the moment EACH `onTokenRefreshed`
 * call runs, so a test can prove the value changes across re-mints rather
 * than staying pinned to whatever `getToken()` returned at attach time.
 */
function recordingNativeAttach(): {
  attach: AttachHls;
  calls: AttachHlsInput[];
  destroyCount: () => number;
  refreshedTokens: () => Array<string | null>;
  reportFatal: () => void;
} {
  const calls: AttachHlsInput[] = [];
  let destroyCount = 0;
  const refreshedTokens: Array<string | null> = [];
  let lastOnFatalError: (() => void) | undefined;
  const attach: AttachHls = (input) => {
    calls.push(input);
    lastOnFatalError = input.onFatalError;
    return {
      destroy() {
        destroyCount += 1;
      },
      onTokenRefreshed() {
        refreshedTokens.push(input.getToken());
      },
    } satisfies StreamPlayerHandle;
  };
  return {
    attach,
    calls,
    destroyCount: () => destroyCount,
    refreshedTokens: () => refreshedTokens,
    reportFatal: () => lastOnFatalError?.(),
  };
}

/**
 * Fix round 1. A plain object standing in for a native-HLS-capable
 * `<video>` — NOT a real happy-dom DOM node: happy-dom's own `<video>`
 * always answers `""` from `canPlayType(...)` (confirmed empirically; there
 * is no native HLS engine in this test environment at all), so a test that
 * needs `defaultAttachHls` to actually TAKE the native branch has to hand it
 * an object that reports canPlayType truthily, the same idea
 * `WatchPage.test.tsx`'s own `safariLikeVideo()` helper uses for
 * `choosePlaybackStrategy`. `Hls.isSupported()` itself is `false` in this
 * environment regardless (no `MediaSource`), so `defaultAttachHls` reaches
 * this branch's `canPlayType` check for ANY video object passed to it here.
 */
function fakeNativeVideo(): {
  video: HTMLVideoElement;
  srcHistory: string[];
  loadCount: () => number;
  fireError: () => void;
} {
  const srcHistory: string[] = [];
  let loadCount = 0;
  let errorHandler: (() => void) | undefined;
  const video = {
    canPlayType: () => "maybe",
    set src(value: string) {
      srcHistory.push(value);
    },
    get src() {
      return srcHistory[srcHistory.length - 1] ?? "";
    },
    load() {
      loadCount += 1;
    },
    play() {
      return Promise.resolve();
    },
    addEventListener(event: string, handler: () => void) {
      if (event === "error") errorHandler = handler;
    },
    removeEventListener() {},
    removeAttribute() {},
  } as unknown as HTMLVideoElement;
  return {
    video,
    srcHistory,
    loadCount: () => loadCount,
    fireError: () => errorHandler?.(),
  };
}

describe("StreamPlayer — minting happens BEFORE attaching, for a gated stream", () => {
  it("does not attach until the token has been minted", async () => {
    const mint = deferred<WatchTokenResult>();
    const { attach, calls } = recordingAttach();

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={() => mint.promise}
      />
    );

    // Give the effect a tick to run — nothing should have attached yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(0);

    mint.resolve(tokenResult("tok-1"));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.getToken()).toBe("tok-1");
  });

  it("appends the freshly-minted token onto the request every time getToken() is read", async () => {
    const { attach, calls } = recordingAttach();

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => tokenResult("tok-abc")}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.hlsUrl).toBe("/u/stream-1/index.m3u8");
    expect(calls[0]!.getToken()).toBe("tok-abc");
  });
});

describe("StreamPlayer — a public stream needs no token at all", () => {
  it("never calls mintToken, and getToken() reads null", async () => {
    const { attach, calls } = recordingAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream({ visibility: "public" })}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          throw new Error("must not be called for a public stream");
        }}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    expect(mintCallCount).toBe(0);
    expect(calls[0]!.getToken()).toBeNull();
  });
});

describe("StreamPlayer — the re-mint interval, on a boundary well under the ten-minute TTL", () => {
  it("re-mints on the interval, and the NEXT request sees the new token", async () => {
    const { attach, calls } = recordingAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          return tokenResult(`tok-${mintCallCount}`);
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    const initialToken = calls[0]!.getToken();
    expect(typeof initialToken).toBe("string");

    // Same attach call, same `getToken` closure throughout — a re-mint must
    // reach it without a second attach. Not pinned to an exact token value:
    // real timers make it impossible to know exactly how many ticks have
    // already landed by the time the first `waitFor` above resolves: the
    // property this test actually needs is "the value changes", not "the
    // value is tok-2 specifically".
    await waitFor(() => expect(calls[0]!.getToken()).not.toBe(initialToken));
    expect(calls.length).toBe(1);
  });
});

describe("StreamPlayer — at minute eleven: a refused re-mint stops the player cleanly", () => {
  it("destroys the attached player and shows the lock — not a broken video element", async () => {
    const { attach, calls, destroyCount } = recordingAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          if (mintCallCount === 1) return tokenResult("tok-1");
          throw new Error("membership lapsed");
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));

    const blocked = await screen.findByTestId("stream-player-blocked");
    // EXACT copy — a literal, never the constant the component itself
    // exports, so a superstring appended later still reddens this.
    expect(blocked.textContent).toBe("Jadi anggota untuk menonton");
    expect(destroyCount()).toBe(1);
  });

  it("never re-mints again after the refusal — the interval is cleared, not merely ignored", async () => {
    const { attach, calls } = recordingAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          if (mintCallCount === 1) return tokenResult("tok-1");
          throw new Error("membership lapsed");
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    await screen.findByTestId("stream-player-blocked");
    const countAtBlock = mintCallCount;
    expect(countAtBlock).toBe(2);

    // Wait several MORE interval periods. A live timer would have fired
    // several more times by now; a cleared one fires zero more.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mintCallCount).toBe(countAtBlock);
  });

  it("no playback path reaches the DOM once blocked", async () => {
    const { attach, calls } = recordingAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream({ hlsPlaybackPath: "/u/stream-1/index.m3u8" })}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          if (mintCallCount === 1) return tokenResult("tok-1");
          throw new Error("membership lapsed");
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    await screen.findByTestId("stream-player-blocked");

    expect(document.body.innerHTML).not.toContain(".m3u8");
  });
});

describe("StreamPlayer — a fatal playback error is the same outcome as a refused re-mint", () => {
  it("shows the lock when the attached player reports a fatal error", async () => {
    const { attach, reportFatal, destroyCount } = recordingAttach();

    render(
      <StreamPlayer
        stream={unlockedStream({ visibility: "public" })}
        attachHls={attach}
        mintToken={async () => {
          throw new Error("must not be called for a public stream");
        }}
      />
    );

    await waitFor(() => expect(screen.queryAllByTestId("stream-player").length).toBe(1));
    reportFatal();

    const blocked = await screen.findByTestId("stream-player-blocked");
    expect(blocked.textContent).toBe("Jadi anggota untuk menonton");
    expect(destroyCount()).toBe(1);
  });
});

describe("StreamPlayer — cleanup on unmount", () => {
  it("destroys the attached player and clears the interval — a timer that outlives the component fires forever otherwise", async () => {
    const { attach, calls, destroyCount } = recordingAttach();
    let mintCallCount = 0;

    const view = render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          return tokenResult(`tok-${mintCallCount}`);
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    const mintCountAtUnmount = mintCallCount;

    view.unmount();
    expect(destroyCount()).toBe(1);

    // If the interval survived unmount, several more re-mints would have
    // fired by now.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mintCallCount).toBe(mintCountAtUnmount);
  });

  it("an in-flight mint that resolves AFTER unmount never attaches", async () => {
    const mint = deferred<WatchTokenResult>();
    const { attach, calls } = recordingAttach();

    const view = render(
      <StreamPlayer stream={unlockedStream()} attachHls={attach} mintToken={() => mint.promise} />
    );

    view.unmount();
    mint.resolve(tokenResult("tok-late"));

    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(0);
  });

  /**
   * The real job of effect 1's `cancelled` flag — NOT preventing an attach
   * after unmount (React's own reconciliation already does that on its own:
   * a `setState` on an unmounted fiber triggers no further render, so the
   * test just above passes even with that flag deleted entirely — proved
   * by deleting it and re-running, per this phase's own rule). What
   * `cancelled` actually guards is a STALE mint from a REPLACED stream
   * landing on the SAME live component instance and corrupting the token
   * `getToken()` is currently serving.
   */
  it("a stale mint from a REPLACED stream never overwrites the new stream's token", async () => {
    const mintA = deferred<WatchTokenResult>();
    const { attach, calls } = recordingAttach();
    const streamA = unlockedStream({ id: "stream-a", hlsPlaybackPath: "/u/stream-a/index.m3u8" });
    const streamB = unlockedStream({ id: "stream-b", hlsPlaybackPath: "/u/stream-b/index.m3u8" });

    const mintToken = (id: string) =>
      id === "stream-a" ? mintA.promise : Promise.resolve(tokenResult("tok-b"));

    const view = render(<StreamPlayer stream={streamA} attachHls={attach} mintToken={mintToken} />);

    // Swap to a different stream BEFORE stream A's mint ever resolves —
    // this is what a viewer navigating between two live rows looks like.
    view.rerender(<StreamPlayer stream={streamB} attachHls={attach} mintToken={mintToken} />);

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.getToken()).toBe("tok-b");

    // Stream A's late mint landing now must change NOTHING — not the token
    // `getToken()` serves, and not a second attach.
    mintA.resolve(tokenResult("tok-a-late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(calls[0]!.getToken()).toBe("tok-b");
  });
});

describe("StreamPlayer — a browser that can play nothing", () => {
  it("shows the unsupported message when attachHls cannot attach anything", async () => {
    render(
      <StreamPlayer
        stream={unlockedStream({ visibility: "public" })}
        attachHls={() => null}
        mintToken={async () => {
          throw new Error("must not be called for a public stream");
        }}
      />
    );

    expect((await screen.findByText(/tidak mendukung/i)).textContent).toBe(
      "Peramban ini tidak mendukung pemutaran siaran langsung."
    );
  });
});

describe("defaultAttachHls — the native branch re-reads the token (fix round 1)", () => {
  it("onTokenRefreshed reloads src with the CURRENT token, not the one captured at attach", () => {
    const { video, srcHistory, loadCount } = fakeNativeVideo();
    let currentToken = "tok-1";

    const handle = defaultAttachHls({
      video,
      hlsUrl: "/u/stream-1/index.m3u8",
      getToken: () => currentToken,
      onFatalError: () => {},
    });

    expect(handle).not.toBeNull();
    expect(srcHistory.length).toBe(1);
    // `withToken` resolves a relative URL against the current origin (see
    // its own docstring in `pages/WatchPage.tsx`) — matched with `toContain`
    // for the same reason `WatchPage.test.tsx`'s own equivalent test does:
    // the origin string itself is an environment detail, not what this test
    // is pinning.
    expect(srcHistory[0]).toContain("/u/stream-1/index.m3u8?token=tok-1");
    expect(new URL(srcHistory[0]!, "http://localhost").searchParams.get("token")).toBe("tok-1");
    expect(loadCount()).toBe(1);

    // A re-mint has landed — getToken() now answers differently.
    currentToken = "tok-2";
    handle!.onTokenRefreshed?.();

    expect(srcHistory.length).toBe(2);
    expect(srcHistory[1]).toContain("/u/stream-1/index.m3u8?token=tok-2");
    // `toContain` alone would not catch a token appended rather than
    // replaced (`tok-2extra`) — pin the token's OWN value exactly too.
    expect(new URL(srcHistory[1]!, "http://localhost").searchParams.get("token")).toBe("tok-2");
    expect(loadCount()).toBe(2);
  });

  it("a fatal video error still reaches onFatalError on the native path", () => {
    const { video, fireError } = fakeNativeVideo();
    let fatalCount = 0;

    defaultAttachHls({
      video,
      hlsUrl: "/u/stream-1/index.m3u8",
      getToken: () => "tok-1",
      onFatalError: () => {
        fatalCount += 1;
      },
    });

    fireError();
    expect(fatalCount).toBe(1);
  });
});

describe("StreamPlayer — the native-shaped handle, wired through the real re-mint loop (fix round 1)", () => {
  it("calls onTokenRefreshed after a successful re-mint tick, and the token it reads is a re-mint's — not the attach-time one", async () => {
    const { attach, calls, refreshedTokens } = recordingNativeAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          return tokenResult(`tok-${mintCallCount}`);
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    // The attach-time token, read once at attach — every LATER call this
    // test inspects must not still be reporting this same value.
    const attachTimeToken = calls[0]!.getToken();

    await waitFor(() => expect(refreshedTokens().length).toBeGreaterThan(0));
    expect(refreshedTokens()[0]).not.toBe(attachTimeToken);
  });

  it("a refused re-mint reaches block() on the native-shaped handle too — destroy fires, the lock shows", async () => {
    const { attach, destroyCount } = recordingNativeAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          if (mintCallCount === 1) return tokenResult("tok-1");
          throw new Error("membership lapsed");
        }}
        remintIntervalMs={5}
      />
    );

    const blocked = await screen.findByTestId("stream-player-blocked");
    expect(blocked.textContent).toBe("Jadi anggota untuk menonton");
    expect(destroyCount()).toBe(1);
  });

  it("the hls.js-shaped handle (no onTokenRefreshed) is unaffected — calling it is a safe no-op", async () => {
    // Guards against the fix regressing the verified hls.js path: its own
    // handle never implements `onTokenRefreshed`, and `StreamPlayer` must
    // not throw or otherwise misbehave when it calls
    // `handle?.onTokenRefreshed?.()` against one that lacks it.
    const { attach, calls } = recordingAttach();
    let mintCallCount = 0;

    render(
      <StreamPlayer
        stream={unlockedStream()}
        attachHls={attach}
        mintToken={async () => {
          mintCallCount += 1;
          return tokenResult(`tok-${mintCallCount}`);
        }}
        remintIntervalMs={5}
      />
    );

    await waitFor(() => expect(calls.length).toBe(1));
    const initialToken = calls[0]!.getToken();
    await waitFor(() => expect(calls[0]!.getToken()).not.toBe(initialToken));
    // Still exactly one attach — the hls.js path re-mints by having its own
    // xhrSetup read getToken() fresh, never by a second attach or a throw.
    expect(calls.length).toBe(1);
  });
});
