// Drives the REAL apps/web dashboard UI (Task 3's EventsPage — device
// pickers, preview, "Mulai siaran dari browser", "Hentikan siaran") in a
// real Chromium browser, against a real `apps/api` dev server, a real
// MediaMTX instance, and this directory's real nginx `/whip/` proxy
// (started persistently by run-dashboard.sh, unlike negotiate.mjs's own
// run.sh which tears its container down right after one negotiation).
//
// Committed per Task 3's fix-round-1 review, Important 5: "commit your
// real-browser harness... so the next person can re-run it" — the earlier
// draft of this verification existed only as an interactive shell session,
// which is exactly the "narrated rather than captured evidence" failure
// mode CONTRIBUTING.md and this project's review history call out
// repeatedly. Re-run this after any change to EventsPage.tsx,
// whip-publisher.ts, or the nginx /whip/ location, rather than trusting the
// transcript below to still be accurate.
//
// Only `getUserMedia` is overridden (a canvas `captureStream()` + Web Audio
// oscillator, standing in for real camera/mic input) — for the SAME
// documented reason Task 1's negotiate.mjs overrides it: this sandboxed
// macOS dev machine cannot grant the OS-level camera/microphone TCC
// permission non-interactively (see CONTRIBUTING.md's "The environment
// finding worth knowing before attempting this again"). Everything
// downstream — the real EventsPage/BrowserPublishSection React component
// tree, the real `publishToWhip`, a real `RTCPeerConnection`, real SDP, real
// ICE, a real POST/DELETE through nginx to MediaMTX — is untouched.
//
// Usage (see run-dashboard.sh for how to get every argument and stand up
// the rest of the stack):
//   bun drive-dashboard.mjs <token> <communityId> <sessionTitle> [webOrigin]
//
// REAL transcript from the run that produced Task 3's fix-round-1 report
// (apps/api on :3000, apps/web on :5173, this directory's nginx harness on
// :18443, a real MediaMTX container):
//
//   ==> expanded Siarkan panel for: loc header check run
//   ==> clicked Aktifkan kamera & mikrofon
//   ==> device access granted, go-live button visible
//   ==> clicked Mulai siaran dari browser — negotiating...
//   WHIP POST response: 201 Location= http://localhost:8443/whip/<key>/<id>
//   ==> LIVE: Hentikan siaran button appeared
//   ==> stopped cleanly, go-live button reappeared
//   RESULT: { "wentLive": true, "stopButtonAppeared": true, "stoppedCleanly": true }
//
// MediaMTX's own log, captured live via `docker logs infra-mediamtx-1` in
// the same run (this is the fact the UI's "Hentikan siaran" button appearing
// is only a PROXY for — the real evidence is the server agreeing):
//
//   INF [WebRTC] [session ...] peer connection established, local candidate: host/udp/127.0.0.1/8189, remote candidate: prflx/udp/172.26.0.1/...
//   INF [path live/<key>] runOnOnline command started
//   INF [path live/<key>] stream is available and online, 2 tracks (Opus, VP8)
//   INF [WebRTC] [session ...] is publishing to path 'live/<key>'
//   ... (after "Hentikan siaran") ...
//   INF [path live/<key>] runOnOnline command stopped
//   INF [path live/<key>] runOnOffline command launched
//   INF [WebRTC] [session ...] closed: peer connection closed
//
// `GET /communities/:id/events` before/after showed the full server-side
// lifecycle: "status":"live" while the button read "Hentikan siaran", then
// "status":"ended" after stopping — pinned in this harness by
// `verifyServerStatus`, not just narrated in a report.

const token = process.argv[2];
const communityId = process.argv[3];
const sessionTitle = process.argv[4];
const webOrigin = process.argv[5] || "http://localhost:5173";
const apiOrigin = process.argv[6] || "http://localhost:3000";

if (!token || !communityId || !sessionTitle) {
  console.error("usage: bun drive-dashboard.mjs <token> <communityId> <sessionTitle> [webOrigin] [apiOrigin]");
  process.exit(1);
}

setTimeout(() => {
  console.log("HARD TIMEOUT — the drive did not complete in time");
  process.exit(1);
}, 60000);

import { chromium } from "playwright";

async function eventStatus(title) {
  const res = await fetch(`${apiOrigin}/communities/${communityId}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const events = await res.json();
  return events.find((e) => e.title === title)?.status ?? null;
}

const browser = await chromium.launch({});
const context = await browser.newContext();
const page = await context.newPage();
page.on("console", (msg) => console.log("console:", msg.text()));
page.on("pageerror", (err) => console.log("pageerror:", err.message));
page.on("requestfailed", (req) =>
  console.log("requestfailed:", req.method(), req.url(), req.failure()?.errorText)
);
page.on("response", async (res) => {
  if (res.url().includes("/whip/") && res.request().method() === "POST") {
    console.log("WHIP POST response:", res.status(), "Location=", res.headers()["location"]);
  }
});

// Same synthetic-media override as negotiate.mjs — see this file's own
// header comment for why a real camera/mic cannot be used here.
await page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    function draw() {
      ctx.fillStyle = `hsl(${Date.now() % 360}, 80%, 50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
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

// Seeds the real session token exactly as a real login would (same
// localStorage keys `apps/web/src/dashboard/auth.ts` uses) — a real
// signup/login already produced this JWT (see run-dashboard.sh); driving the
// login FORM itself is not what this harness exists to prove.
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

console.log("==> navigating to the real EventsPage");
await page.goto(`${webOrigin}/dashboard/c/${communityId}/streaming`, { waitUntil: "load" });
await page.waitForSelector("text=Siaran langsung", { timeout: 10000 });

// Picked by TITLE, not by position — the table can carry earlier runs' (now
// `ended`) sessions too, and those rows render no "Aktifkan kamera" button
// at all (BrowserPublishSection's own `status === "ended"` branch).
const row = page.locator("tr", { hasText: sessionTitle });
await row.getByRole("button", { name: "Siarkan" }).click();
console.log("==> expanded Siarkan panel for:", sessionTitle);

await page.getByRole("button", { name: /Aktifkan kamera/ }).click();
console.log("==> clicked Aktifkan kamera & mikrofon");

await page.waitForSelector('button:has-text("Mulai siaran dari browser")', { timeout: 10000 });
console.log("==> device access granted, go-live button visible");

await page.getByRole("button", { name: "Mulai siaran dari browser" }).click();
console.log("==> clicked Mulai siaran dari browser — negotiating...");

const result = {
  wentLive: false,
  stopButtonAppeared: false,
  serverStatusWhileLive: null,
  errorText: null,
  stoppedCleanly: false,
  serverStatusAfterStop: null,
};

try {
  await page.waitForSelector('button:has-text("Hentikan siaran")', { timeout: 20000 });
  result.stopButtonAppeared = true;
  result.wentLive = true;
  console.log("==> LIVE: Hentikan siaran button appeared");
} catch (e) {
  const errorEl = await page.$(".form-error");
  result.errorText = errorEl ? await errorEl.textContent() : `no error element; ${e.message}`;
  console.log("==> FAILED to go live:", result.errorText);
}

if (result.wentLive) {
  // Not just the UI's own opinion — ask the server too. This is the check
  // that would have caught fix round 1's Critical 1 (the UI reporting
  // "live" over signalling-only success) had this harness existed then.
  result.serverStatusWhileLive = await eventStatus(sessionTitle);
  console.log("==> server-reported status while UI shows live:", result.serverStatusWhileLive);

  await page.getByRole("button", { name: "Hentikan siaran" }).click();
  await page.waitForSelector('button:has-text("Mulai siaran dari browser")', { timeout: 10000 });
  result.stoppedCleanly = true;
  console.log("==> stopped cleanly, go-live button reappeared");

  // MediaMTX's own offline hook can take a moment to fire after the peer
  // connection closes — small bounded retry rather than a fixed sleep.
  for (let attempt = 0; attempt < 10; attempt++) {
    result.serverStatusAfterStop = await eventStatus(sessionTitle);
    if (result.serverStatusAfterStop === "ended") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("==> server-reported status after stop:", result.serverStatusAfterStop);
}

console.log("RESULT:", JSON.stringify(result, null, 2));

await browser.close();
const ok =
  result.wentLive &&
  result.serverStatusWhileLive === "live" &&
  result.stoppedCleanly &&
  result.serverStatusAfterStop === "ended";
process.exit(ok ? 0 : 1);
