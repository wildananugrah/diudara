// Task 4 (the phase gate) — the ONE checklist item Task 3's own harness did
// not cover: a real MEMBER, in a SECOND browser context, actually watching
// the video a creator is publishing from their browser.
//
// Extends drive-dashboard.mjs's cycle rather than replacing it:
//   1. creator goes live from the real dashboard UI (real RTCPeerConnection,
//      real SDP, real ICE, through the real nginx `/whip/` location to a real
//      MediaMTX) — same as drive-dashboard.mjs
//   2. the SERVER's own status flips to `live` (not the UI's say-so)
//   3. an `activity_log` row appears — read back through the real
//      `GET /communities/:id/activity` endpoint
//   4. NEW: a SECOND browser context opens the member watch page at the real
//      `/watch/<token>` URL a real `GET /c/subscription/:id/status` minted,
//      and video frames actually advance
//   5. creator stops; the server's status flips to `ended`; a second
//      `activity_log` row appears
//
// WHAT "VIDEO PLAYING" MEANS HERE, precisely: the published stream is a
// synthetic canvas (see driver-support.mjs for why a real camera cannot be
// used on this machine), so there is no recognisable picture to look at. The
// assertion is therefore the mechanical one that actually matters —
// `readyState >= 3` (HAVE_FUTURE_DATA), non-zero `videoWidth`/`videoHeight`,
// `paused === false`, and `currentTime` STRICTLY ADVANCING between two
// samples a second apart. A still frame, a black frame, or a stalled player
// all fail that.
//
// THE MEMBER'S URL CARRIES NO STREAM KEY — asserted, not assumed. The public
// HLS path is `/live/<eventId>/index.m3u8` and nginx rewrites it onto
// MediaMTX's internal `/live/<streamKey>/...` after re-authorising; that
// indirection was a Critical fix in the previous phase. This driver fails if
// the stream key appears anywhere in the member page's URL, in the resolved
// `hlsUrl`, or in any URL the member's browser requests.
//
// Usage (run-gate.sh supplies every argument):
//   bun drive-gate.mjs <token> <communityId> <sessionTitle> <subscriptionId> <webOrigin> <apiOrigin>

import { chromium } from "playwright";
import {
  eventRow,
  eventStatus,
  grantDevices,
  installSyntheticMedia,
  openPublishPanel,
  pollFor,
  seedDashboardSession,
  tracePage,
} from "./driver-support.mjs";

const token = process.argv[2];
const communityId = process.argv[3];
const sessionTitle = process.argv[4];
const subscriptionId = process.argv[5];
const webOrigin = process.argv[6] || "http://localhost:5173";
const apiOrigin = process.argv[7] || "http://localhost:3000";

if (!token || !communityId || !sessionTitle || !subscriptionId) {
  console.error(
    "usage: bun drive-gate.mjs <token> <communityId> <sessionTitle> <subscriptionId> [webOrigin] [apiOrigin]"
  );
  process.exit(1);
}

setTimeout(() => {
  console.log("HARD TIMEOUT — the gate drive did not complete in time");
  process.exit(1);
}, 180000);

/**
 * The creator's real activity feed. NOTE the deliberate API shape this has to
 * work with: `GetCommunityActivity` does NOT expose the row's raw `metadata`
 * (its own docstring explains why — a jsonb blob shipped to a browser
 * publishes whatever a future writer adds to it), so this cannot match on
 * `metadata.eventId`. It matches on `eventType` instead, and run-gate.sh
 * separately queries Postgres directly for the row's `metadata->>'eventId'`,
 * which is the stronger check and the one that pins the row to THIS event.
 */
async function activityEntries() {
  const res = await fetch(`${apiOrigin}/communities/${communityId}/activity?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return Array.isArray(body?.entries) ? body.entries : [];
}

async function subscriptionStatus() {
  const res = await fetch(`${apiOrigin}/c/subscription/${subscriptionId}/status`);
  return res.json();
}

const result = {
  streamKeyLength: null,
  wentLive: false,
  serverStatusWhileLive: null,
  activityRowWhileLive: null,
  memberWatchUrlMintedWhileLive: false,
  memberResolvedHlsUrl: null,
  memberHlsUrlLeaksStreamKey: null,
  memberPlayback: null,
  memberRequestUrlsLeakingStreamKey: [],
  stoppedCleanly: false,
  serverStatusAfterStop: null,
  activityRowAfterStop: null,
  publishErrorText: null,
};

const browser = await chromium.launch({});

// ---------------------------------------------------------------- creator
const creatorContext = await browser.newContext();
const creatorPage = await creatorContext.newPage();
tracePage(creatorPage, "creator");
creatorPage.on("response", async (res) => {
  if (res.url().includes("/whip/") && res.request().method() === "POST") {
    console.log("WHIP POST response:", res.status(), "Location=", res.headers()["location"]);
  }
});
await installSyntheticMedia(creatorPage);
await seedDashboardSession(creatorPage, token);

const row = await eventRow({ apiOrigin, token, communityId, sessionTitle });
if (!row) {
  console.log("could not find the session row for", sessionTitle);
  process.exit(1);
}
const eventId = row.id;
const streamKey = row.streamKey;
result.streamKeyLength = typeof streamKey === "string" ? streamKey.length : null;
console.log("==> event id:", eventId, "(stream key withheld from this log on purpose)");

await openPublishPanel(creatorPage, { webOrigin, communityId, sessionTitle });
console.log("==> expanded Siarkan panel for:", sessionTitle);
await grantDevices(creatorPage);
console.log("==> device access granted, local preview element present");

await creatorPage.waitForSelector('button:has-text("Mulai siaran dari browser")', { timeout: 15000 });
await creatorPage.getByRole("button", { name: "Mulai siaran dari browser" }).click();
console.log("==> clicked Mulai siaran dari browser — negotiating...");

try {
  await creatorPage.waitForSelector('button:has-text("Hentikan siaran")', { timeout: 25000 });
  result.wentLive = true;
  console.log("==> LIVE: Hentikan siaran button appeared");
} catch (e) {
  const errorEl = await creatorPage.$(".form-error");
  result.publishErrorText = errorEl ? await errorEl.textContent() : `no error element; ${e.message}`;
  console.log("==> FAILED to go live:", result.publishErrorText);
}

if (result.wentLive) {
  // The LOCAL preview, before looking at anything server-side: proof the
  // creator's own screen shows moving video, not a dead box.
  const preview = await creatorPage.evaluate(async () => {
    const video = document.querySelector("video.video-preview");
    if (!video) return { present: false };
    const first = video.currentTime;
    await new Promise((r) => setTimeout(r, 1000));
    return {
      present: true,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      paused: video.paused,
      advanced: video.currentTime > first,
      currentTime: video.currentTime,
    };
  });
  console.log("==> creator local preview:", JSON.stringify(preview));
  result.creatorPreview = preview;

  result.serverStatusWhileLive = await pollFor(
    () => eventStatus({ apiOrigin, token, communityId, sessionTitle }),
    "live"
  );
  console.log("==> server-reported status while UI shows live:", result.serverStatusWhileLive);

  result.activityRowWhileLive =
    (await activityEntries()).find((r) => r.eventType === "stream_live") ?? null;
  console.log("==> activity_log row while live:", JSON.stringify(result.activityRowWhileLive));

  // ---------------------------------------------------------------- member
  const status = await subscriptionStatus();
  console.log("==> member subscription status:", JSON.stringify(status));
  if (typeof status.watchUrl === "string" && status.watchUrl.startsWith("/watch/")) {
    result.memberWatchUrlMintedWhileLive = true;
    const watchToken = status.watchUrl.slice("/watch/".length);

    const resolved = await (
      await fetch(`${apiOrigin}/c/watch/${watchToken}`)
    ).json();
    result.memberResolvedHlsUrl = resolved.hlsUrl ?? null;
    result.memberHlsUrlLeaksStreamKey =
      typeof resolved.hlsUrl === "string" && streamKey ? resolved.hlsUrl.includes(streamKey) : null;
    console.log("==> member-facing hlsUrl:", result.memberResolvedHlsUrl);
    console.log("==> that hlsUrl contains the stream key?", result.memberHlsUrlLeaksStreamKey);

    // A SEPARATE browser context — its own cookie jar, its own storage, no
    // dashboard token, no getUserMedia override. As close to "a second
    // browser" as one Chromium process gets.
    const memberContext = await browser.newContext();
    const memberPage = await memberContext.newPage();
    tracePage(memberPage, "member");
    memberPage.on("request", (req) => {
      if (streamKey && req.url().includes(streamKey)) {
        result.memberRequestUrlsLeakingStreamKey.push(req.url());
      }
    });

    const memberUrl = `${webOrigin}${status.watchUrl}`;
    console.log("==> member navigating to /watch/<token> in a second browser context");
    await memberPage.goto(memberUrl, { waitUntil: "load" });
    try {
      await memberPage.waitForSelector("text=Sedang tayang langsung", { timeout: 20000 });
      console.log('==> member page reached the "Sedang tayang langsung" phase');
    } catch {
      const heading = await memberPage.textContent("h1").catch(() => null);
      console.log("==> member page did NOT reach playback; heading was:", heading);
    }

    // The real check: frames advancing, twice sampled a second apart.
    result.memberPlayback = await memberPage.evaluate(async () => {
      const video = document.querySelector("video");
      if (!video) return { present: false };
      // Give hls.js up to 20s to fill the buffer and start rendering.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && (video.readyState < 3 || video.videoWidth === 0)) {
        await new Promise((r) => setTimeout(r, 500));
      }
      const first = video.currentTime;
      await new Promise((r) => setTimeout(r, 1500));
      const second = video.currentTime;
      return {
        present: true,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        paused: video.paused,
        firstCurrentTime: first,
        secondCurrentTime: second,
        advanced: second > first,
        src: video.currentSrc || video.src || "(via MediaSource)",
      };
    });
    console.log("==> member playback:", JSON.stringify(result.memberPlayback));
    console.log(
      "==> member requests carrying the stream key:",
      result.memberRequestUrlsLeakingStreamKey.length
    );
    await memberContext.close();
  } else {
    console.log("==> NO watchUrl minted for the member while the session was live");
  }

  // ---------------------------------------------------------------- stop
  await creatorPage.getByRole("button", { name: "Hentikan siaran" }).click();
  await creatorPage.waitForSelector('button:has-text("Mulai siaran dari browser")', {
    timeout: 15000,
  });
  result.stoppedCleanly = true;
  console.log("==> stopped cleanly, go-live button reappeared");

  result.serverStatusAfterStop = await pollFor(
    () => eventStatus({ apiOrigin, token, communityId, sessionTitle }),
    "ended"
  );
  console.log("==> server-reported status after stop:", result.serverStatusAfterStop);

  result.activityRowAfterStop =
    (await activityEntries()).find((r) => r.eventType === "stream_ended") ?? null;
  console.log("==> activity_log row after stop:", JSON.stringify(result.activityRowAfterStop));
}

console.log("RESULT:", JSON.stringify(result, null, 2));

await browser.close();

const ok =
  result.wentLive &&
  result.serverStatusWhileLive === "live" &&
  result.activityRowWhileLive !== null &&
  result.memberWatchUrlMintedWhileLive &&
  result.memberHlsUrlLeaksStreamKey === false &&
  result.memberPlayback?.present === true &&
  result.memberPlayback.readyState >= 3 &&
  result.memberPlayback.videoWidth > 0 &&
  result.memberPlayback.paused === false &&
  result.memberPlayback.advanced === true &&
  result.memberRequestUrlsLeakingStreamKey.length === 0 &&
  result.stoppedCleanly &&
  result.serverStatusAfterStop === "ended" &&
  result.activityRowAfterStop !== null;

console.log(ok ? "GATE DRIVE: PASS" : "GATE DRIVE: FAIL");
process.exit(ok ? 0 : 1);
