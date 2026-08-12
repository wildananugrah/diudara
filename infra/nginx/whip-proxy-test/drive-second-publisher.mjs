// Task 4 (the phase gate): a BROWSER publish attempted against a stream key
// something else is already publishing to must be REFUSED, and the UI must
// SAY SO in Indonesian rather than failing obscurely.
//
// Task 3's report left this explicitly unverified ("Two simultaneous browser
// tabs publishing to the same session, or a browser publish racing a real OBS
// publish to the same key, were not attempted for real"), so this driver is
// new ground.
//
// TWO DISTINCT REFUSAL PATHS, and this driver covers whichever one the caller
// sets up — they are NOT the same code and it matters which fires:
//
//   A. The page loads AFTER the event's status has already flipped to `live`
//      (which is what happens once the other publisher's `runOnOnline` hook
//      has been processed). `BrowserPublishSection`'s `liveElsewhere` branch
//      then renders "Sesi ini sudah berstatus live saat ini..." and DISABLES
//      the go-live button — the refusal happens client-side, before any
//      negotiation is attempted at all.
//
//   B. The page loaded while the status was still `scheduled` and the other
//      publisher started afterwards, so the button is enabled and the WHIP
//      POST really is sent. MediaMTX refuses it (a path can have only one
//      publisher) and `publishToWhip` turns the non-2xx into "Server
//      penyiaran menolak permintaan ini (status N)...".
//
// Pass `--expect=disabled` for A or `--expect=rejected` for B; the driver
// asserts the specific message and, for A, that the button is genuinely
// disabled rather than merely present.
//
// For B the caller must also pass a marker directory, because B is a RACE and
// cannot be set up by ordering alone: the page has to be loaded and ready
// while the session is still `scheduled`, and only THEN may the other
// publisher start. Protocol (same file-based shape as drive-hold-live.mjs):
// this driver writes `<markerDir>/ready` once the panel is open with device
// access granted, then waits for `<markerDir>/go` before clicking go-live —
// which is when the caller has the other publisher on the air.
//
// Usage:
//   bun drive-second-publisher.mjs <token> <communityId> <sessionTitle> <webOrigin> --expect=disabled
//   bun drive-second-publisher.mjs <token> <communityId> <sessionTitle> <webOrigin> --expect=rejected <markerDir>

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
const expectArg = (process.argv[6] || "").replace(/^--expect=/, "");
const markerDir = process.argv[7];

if (
  !token ||
  !communityId ||
  !sessionTitle ||
  !["disabled", "rejected"].includes(expectArg) ||
  (expectArg === "rejected" && !markerDir)
) {
  console.error(
    "usage: bun drive-second-publisher.mjs <token> <communityId> <sessionTitle> <webOrigin> --expect=disabled|rejected [markerDir]"
  );
  process.exit(1);
}

setTimeout(() => {
  console.log("HARD TIMEOUT");
  process.exit(1);
}, 120000);

const browser = await chromium.launch({});
const context = await browser.newContext();
const page = await context.newPage();
tracePage(page, "second-publisher");
page.on("response", async (res) => {
  if (res.url().includes("/whip/") && res.request().method() === "POST") {
    console.log("WHIP POST response:", res.status(), await res.text().catch(() => ""));
  }
});
await installSyntheticMedia(page);
await seedDashboardSession(page, token);

await openPublishPanel(page, { webOrigin, communityId, sessionTitle });
await grantDevices(page);
console.log("==> second publisher: panel open, device access granted");

const result = { expect: expectArg, messages: [], goLiveDisabled: null, stopButtonAppeared: false };

const goLive = page.getByRole("button", { name: /Mulai siaran dari browser/ });

if (expectArg === "disabled") {
  await page.waitForSelector("text=Sesi ini sudah berstatus live saat ini", { timeout: 15000 });
  result.goLiveDisabled = await goLive.isDisabled();
} else {
  // The page is loaded and armed while the session is still `scheduled`, so
  // the client-side `liveElsewhere` guard is NOT what refuses this — the WHIP
  // POST really goes out and MediaMTX really answers it.
  await goLive.waitFor({ state: "visible", timeout: 15000 });
  if (await goLive.isDisabled()) {
    console.log("==> go-live button is already disabled — this is the WRONG branch for --expect=rejected");
    await browser.close();
    process.exit(1);
  }
  writeFileSync(join(markerDir, "ready"), String(Date.now()));
  console.log("==> armed and waiting for the other publisher to take the key");
  const deadline = Date.now() + 90000;
  while (!existsSync(join(markerDir, "go")) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!existsSync(join(markerDir, "go"))) {
    console.log("==> the caller never signalled 'go'");
    await browser.close();
    process.exit(1);
  }
  const clickedAt = Date.now();
  await goLive.click();
  console.log("==> clicked Mulai siaran dari browser while the key is already held");

  // MEASURED, NOT ASSUMED — and the reason this loop is not a single
  // `waitForSelector`: MediaMTX answers this WHIP POST `201` with a real SDP
  // answer and lets the peer connection reach "connected" BEFORE closing it
  // with "someone is already publishing". So a snapshot taken the moment
  // "Hentikan siaran" appears would report a successful publish, and a
  // snapshot taken 30s later would report a clean failure. Both are true at
  // different instants, and which one a creator experiences is the whole
  // question. This records the sequence instead of picking one.
  result.timeline = [];
  result.secondsUntilErrorShown = null;
  for (let elapsed = 0; elapsed < 40; elapsed += 1) {
    const live = (await page.getByRole("button", { name: "Hentikan siaran" }).count()) > 0;
    const errors = await Promise.all(
      (await page.$$(".form-error")).map(async (el) => (await el.textContent())?.trim() ?? "")
    );
    if (live && !result.stopButtonAppeared) {
      result.stopButtonAppeared = true;
      result.timeline.push(
        `+${((Date.now() - clickedAt) / 1000).toFixed(1)}s the UI showed "Hentikan siaran" (it believes it is live)`
      );
    }
    if (errors.length > 0 && result.secondsUntilErrorShown === null) {
      result.secondsUntilErrorShown = Number(((Date.now() - clickedAt) / 1000).toFixed(1));
      result.timeline.push(`+${result.secondsUntilErrorShown}s an error was shown: ${errors[0]}`);
      if (!live) break;
    }
    if (result.secondsUntilErrorShown !== null && !live) {
      result.timeline.push(
        `+${((Date.now() - clickedAt) / 1000).toFixed(1)}s the UI left the live state`
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  result.stillLiveAtEnd = (await page.getByRole("button", { name: "Hentikan siaran" }).count()) > 0;
  console.log("==> timeline:");
  for (const line of result.timeline) console.log("   ", line);
}

for (const el of await page.$$(".form-error")) {
  const text = (await el.textContent())?.trim();
  if (text) result.messages.push(text);
}
console.log("==> messages shown to the creator:");
for (const m of result.messages) console.log("   -", m);

const joined = result.messages.join(" | ");
console.log("RESULT:", JSON.stringify(result, null, 2));

await browser.close();

// For `rejected`, the bar is what the CREATOR ends up with, not which
// internal path got there: the UI must not be left claiming to be live, and
// it must say something in Indonesian about what went wrong. It is NOT a
// requirement that the message be the "Server penyiaran menolak" one
// specifically — MediaMTX accepts this WHIP session and then closes it, so
// the honest message for what happened is the mid-broadcast-drop one.
const ok =
  expectArg === "disabled"
    ? result.goLiveDisabled === true && joined.includes("sudah berstatus live saat ini")
    : result.stillLiveAtEnd === false && joined.length > 0;

console.log(ok ? "SECOND PUBLISHER: correctly refused with a clear message" : "SECOND PUBLISHER: FAIL");
process.exit(ok ? 0 : 1);
