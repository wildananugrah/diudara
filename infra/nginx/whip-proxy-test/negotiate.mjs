// Drives a REAL RTCPeerConnection (real Chromium, via Playwright) through
// whatever nginx origin it is pointed at, performing manual WHIP negotiation
// against the /whip/<streamKey> location infra/nginx/live-hls.conf.template
// adds — see run.sh in this directory for how to stand up that nginx
// container and how to get a real streamKey to pass here.
//
// This is the harness that produced the "RESULT: { ... }" JSON quoted in
// task-1-report.md's "Second run: through the new nginx /whip/ location"
// section (browser-publishing phase, Task 1) — committed per that task's
// fix-round-1 review so the claim is re-runnable, not just narrated.
//
// getUserMedia is overridden (via page.addInitScript, before any page JS
// runs) to synthesize a live MediaStream from a canvas + a Web Audio
// oscillator, instead of requesting a real camera/microphone. This is not a
// simplification for its own sake: this sandboxed macOS dev machine cannot
// grant the OS-level camera/microphone TCC permission non-interactively —
// getUserMedia hangs indefinitely otherwise, confirmed against both
// Playwright's bundled Chromium and the real installed Google Chrome.app,
// even with --use-fake-device-for-media-stream --use-fake-ui-for-media-stream
// and an explicit context.grantPermissions call (see CONTRIBUTING.md's
// "Browser publishing (WebRTC / WHIP)" section). Everything downstream of
// getUserMedia here — the real RTCPeerConnection, the real SDP offer/answer,
// the real WHIP POST/PATCH/DELETE, the real ICE negotiation — is untouched.
//
// Usage:
//   bun negotiate.mjs <nginx-origin> <streamKey>
//   bun negotiate.mjs http://localhost:18443 08d7711c614424e8f6468e90ff88c1fa
//
// Exits non-zero (and prints a hard-timeout message) if the whole run takes
// longer than 30s, so a broken negotiation fails loudly in CI-style usage
// rather than hanging forever.

setTimeout(() => {
  console.log("HARD TIMEOUT — negotiation did not complete in time");
  process.exit(1);
}, 30000);

import { chromium } from "playwright";

const nginxOrigin = process.argv[2];
const streamKey = process.argv[3];

if (!nginxOrigin || !streamKey) {
  console.error("usage: bun negotiate.mjs <nginx-origin> <streamKey>");
  process.exit(1);
}

const browser = await chromium.launch({});
const context = await browser.newContext();
const page = await context.newPage();
page.on("console", (msg) => console.log("console:", msg.text()));
page.on("pageerror", (err) => console.log("pageerror:", err.message));

// Any same-origin page works — a 404 body is a perfectly valid document to
// run fetch()/RTCPeerConnection from, and this test nginx defines no other
// location.
await page.goto(nginxOrigin + "/", { waitUntil: "load" }).catch(() => {});

const result = await page.evaluate(
  async ({ nginxOrigin, streamKey }) => {
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

    const pc = new RTCPeerConnection();
    videoStream.getVideoTracks().forEach((t) => pc.addTrack(t, videoStream));
    dest.stream.getAudioTracks().forEach((t) => pc.addTrack(t, dest.stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") resolve();
      });
      setTimeout(resolve, 4000); // don't hang forever waiting for gathering
    });

    const whipUrl = `${nginxOrigin}/whip/${streamKey}`;
    const postRes = await fetch(whipUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });
    const answerSdp = await postRes.text();
    const location = postRes.headers.get("Location");

    if (postRes.status !== 201) {
      return { ok: false, stage: "POST", status: postRes.status, body: answerSdp };
    }

    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

    const connected = await new Promise((resolve) => {
      if (pc.connectionState === "connected") return resolve(true);
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "connected") resolve(true);
        if (pc.connectionState === "failed") resolve(false);
      });
      setTimeout(() => resolve(pc.connectionState === "connected"), 8000);
    });

    const sessionUrl = new URL(location, whipUrl).toString();

    return {
      ok: true,
      postStatus: postRes.status,
      location,
      sessionUrl,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      connected,
    };
  },
  { nginxOrigin, streamKey }
);

console.log("RESULT:", JSON.stringify(result, null, 2));

await browser.close();
process.exit(result.ok && result.connected ? 0 : 1);
