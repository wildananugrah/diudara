// Shared browser-driving helpers for the Task 4 gate drivers
// (drive-gate.mjs, drive-second-publisher.mjs, drive-hold-live.mjs).
//
// Task 3's own two drivers (drive-dashboard.mjs, drive-dashboard-denied.mjs)
// each carry their own inline copy of the `getUserMedia` override and the
// localStorage session seeding. Those two are DELIBERATELY left untouched —
// they are the artifacts Task 3's review verified by execution, and
// refactoring proven verification code while using it to verify something
// else is exactly how a green harness stops meaning anything. This module is
// the shared version for the NEW drivers only.
//
// WHY `getUserMedia` IS OVERRIDDEN AT ALL — the single most important caveat
// in this whole harness: this machine cannot grant the OS-level (macOS TCC)
// camera/microphone permission non-interactively. `getUserMedia` hangs
// forever behind a native system dialog that nothing in a headless shell can
// click, even with Chromium's own `--use-fake-device-for-media-stream`
// flags (measured in Task 1, against both Playwright's Chromium and the real
// Google Chrome.app, and against a trivial local page with no MediaMTX
// involved at all). The override returns a synthetic canvas + Web Audio
// stream INSTEAD OF calling the OS camera API, so the OS gate is never
// reached. Everything downstream is real and untouched: the real React
// component tree, the real `publishToWhip`, a real `RTCPeerConnection`, real
// SDP, real ICE, real POST/PATCH/DELETE through real nginx to real MediaMTX.
//
// WHAT THAT LEAVES UNPROVEN, stated here rather than only in a report:
// real camera/microphone HARDWARE, and the real permission-grant UX a human
// sees. Neither is exercised by any run of this harness.

/**
 * Replaces `navigator.mediaDevices.getUserMedia` with an animated canvas
 * `captureStream()` plus a Web Audio oscillator — a genuinely MOVING picture
 * (the fill colour advances every frame from `Date.now()`), not one static
 * frame, so "frames advancing" downstream means something.
 *
 * Must be installed via `addInitScript` (i.e. before the page's own
 * JavaScript runs), which is why this takes a `page` rather than being
 * called inside one.
 */
export async function installSyntheticMedia(page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const ctx = canvas.getContext("2d");
      function draw() {
        ctx.fillStyle = `hsl(${Date.now() % 360}, 80%, 50%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        // A second, MOVING element so a frame is never identical to its
        // predecessor even if two frames land in the same hue bucket —
        // otherwise an encoder could legitimately drop them as duplicates
        // and the member-side "frames advancing" check would be testing
        // the encoder's duplicate handling rather than the stream.
        ctx.fillStyle = "#000";
        ctx.fillRect((Date.now() / 10) % canvas.width, 100, 40, 40);
        requestAnimationFrame(draw);
      }
      draw();
      const videoStream = canvas.captureStream(30);
      const audioCtx = new AudioContext();
      const osc = audioCtx.createOscillator();
      const dest = audioCtx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
    const realEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
      const real = await realEnumerate();
      if (real.length > 0) return real;
      return [
        { deviceId: "synthetic-camera", kind: "videoinput", label: "Synthetic Camera", groupId: "" },
        { deviceId: "synthetic-mic", kind: "audioinput", label: "Synthetic Mic", groupId: "" },
      ];
    };
  });
}

/**
 * Seeds the dashboard session exactly as a real login leaves it — the same
 * two localStorage keys `apps/web/src/dashboard/auth.ts` writes. The JWT was
 * already produced by a real `POST /auth/signup` (see run-gate.sh); driving
 * the login FORM is not what these drivers exist to prove.
 */
export async function seedDashboardSession(page, token) {
  await page.addInitScript(
    ({ token }) => {
      localStorage.setItem("diudara.dashboard.token", token);
      localStorage.setItem(
        "diudara.dashboard.creator",
        JSON.stringify({ id: "verify", name: "Whip Tester", email: "whiptest@example.com" })
      );
    },
    { token }
  );
}

/** Pipes a page's console/error/network failures into this process's stdout. */
export function tracePage(page, label) {
  page.on("console", (msg) => console.log(`[${label}] console:`, msg.text()));
  page.on("pageerror", (err) => console.log(`[${label}] pageerror:`, err.message));
  page.on("requestfailed", (req) =>
    console.log(`[${label}] requestfailed:`, req.method(), req.url(), req.failure()?.errorText)
  );
}

/**
 * Opens the creator's live-streaming screen and expands the browser-publish
 * panel for the row whose title matches — BY TITLE, not by position: the
 * table also carries earlier runs' `ended` sessions, whose rows render no
 * device button at all.
 */
export async function openPublishPanel(page, { webOrigin, communityId, sessionTitle }) {
  await page.goto(`${webOrigin}/dashboard/c/${communityId}/streaming`, { waitUntil: "load" });
  await page.waitForSelector("text=Siaran langsung", { timeout: 15000 });
  const row = page.locator("tr", { hasText: sessionTitle });
  await row.getByRole("button", { name: "Siarkan" }).click();
  return row;
}

/** Clicks "Aktifkan kamera & mikrofon" and waits for the preview to be ready. */
export async function grantDevices(page) {
  await page.getByRole("button", { name: /Aktifkan kamera/ }).click();
  await page.waitForSelector(".video-preview", { timeout: 15000 });
}

/** The server's own opinion of a session's status — never the UI's. */
export async function eventStatus({ apiOrigin, token, communityId, sessionTitle }) {
  const res = await fetch(`${apiOrigin}/communities/${communityId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const events = await res.json();
  return events.find((e) => e.title === sessionTitle)?.status ?? null;
}

/** The full event row (id, status, ...) for one session title. */
export async function eventRow({ apiOrigin, token, communityId, sessionTitle }) {
  const res = await fetch(`${apiOrigin}/communities/${communityId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const events = await res.json();
  return events.find((e) => e.title === sessionTitle) ?? null;
}

/** Polls until `read()` returns `want`, or gives up. Returns the last value seen. */
export async function pollFor(read, want, { attempts = 20, intervalMs = 500 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await read();
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
