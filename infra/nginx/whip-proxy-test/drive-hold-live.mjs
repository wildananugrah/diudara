// Task 4 (the phase gate): goes live from the real dashboard UI and HOLDS the
// publish open until a marker file appears, so the calling shell script can do
// something else against the same stream key while a real browser publish is
// genuinely in progress.
//
// Exists for the reverse direction of the second-publisher check: "an ffmpeg
// (i.e. OBS-equivalent) RTMP publish attempted while a BROWSER publish holds
// the key must be refused." Coordinating that needs the browser publish to
// still be running when ffmpeg starts, which no single-shot driver can do.
//
// Protocol, deliberately file-based rather than stdin/stdout parsing (a shell
// reading a background process's stdout while also running ffmpeg is where
// this kind of harness usually goes wrong):
//   1. driver goes live, then creates <markerDir>/live
//   2. the shell waits for that file, does its thing, then creates
//      <markerDir>/release
//   3. driver sees `release`, clicks "Hentikan siaran", verifies the UI
//      returned to its pre-live state, and exits 0
// A hold longer than `maxHoldSeconds` exits non-zero rather than hanging.
//
// Usage:
//   bun drive-hold-live.mjs <token> <communityId> <sessionTitle> <webOrigin> <markerDir> [maxHoldSeconds]

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  grantDevices,
  installSyntheticMedia,
  openPublishPanel,
  seedDashboardSession,
  tracePage,
} from "./driver-support.mjs";

const token = process.argv[2];
const communityId = process.argv[3];
const sessionTitle = process.argv[4];
const webOrigin = process.argv[5] || "http://localhost:5173";
const markerDir = process.argv[6];
const maxHoldSeconds = Number(process.argv[7] || 90);

if (!token || !communityId || !sessionTitle || !markerDir) {
  console.error(
    "usage: bun drive-hold-live.mjs <token> <communityId> <sessionTitle> <webOrigin> <markerDir> [maxHoldSeconds]"
  );
  process.exit(1);
}

const liveMarker = join(markerDir, "live");
const releaseMarker = join(markerDir, "release");

setTimeout(
  () => {
    console.log("HARD TIMEOUT while holding a live publish");
    process.exit(1);
  },
  (maxHoldSeconds + 90) * 1000
);

const browser = await chromium.launch({});
const context = await browser.newContext();
const page = await context.newPage();
tracePage(page, "hold-live");
page.on("response", (res) => {
  if (res.url().includes("/whip/") && res.request().method() === "POST") {
    console.log("WHIP POST response:", res.status(), "Location=", res.headers()["location"]);
  }
});
await installSyntheticMedia(page);
await seedDashboardSession(page, token);

await openPublishPanel(page, { webOrigin, communityId, sessionTitle });
await grantDevices(page);
await page.getByRole("button", { name: "Mulai siaran dari browser" }).click();
console.log("==> hold-live: clicked go-live, negotiating...");

try {
  await page.waitForSelector('button:has-text("Hentikan siaran")', { timeout: 25000 });
} catch (e) {
  const errorEl = await page.$(".form-error");
  console.log("==> hold-live FAILED to go live:", errorEl ? await errorEl.textContent() : e.message);
  await browser.close();
  process.exit(1);
}
console.log("==> hold-live: LIVE — holding the publish open");
writeFileSync(liveMarker, String(Date.now()));

const deadline = Date.now() + maxHoldSeconds * 1000;
while (!existsSync(releaseMarker) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}
const released = existsSync(releaseMarker);
console.log(released ? "==> hold-live: released by the caller" : "==> hold-live: hold TIMED OUT");

// Still stop cleanly either way — an abandoned publish would poison every
// later check in the same run.
await page.getByRole("button", { name: "Hentikan siaran" }).click();
await page
  .waitForSelector('button:has-text("Mulai siaran dari browser")', { timeout: 15000 })
  .catch(() => console.log("==> hold-live: go-live button did not reappear after stopping"));
console.log("==> hold-live: stopped");

await browser.close();
process.exit(released ? 0 : 1);
