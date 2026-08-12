// The SAME real dashboard, real browser, real `apps/api` as
// drive-dashboard.mjs — but `getUserMedia` REJECTS with a real
// `DOMException("NotAllowedError")` instead of returning a synthetic
// stream, to verify the permission-denied message (Task 3's own Indonesian
// copy, apps/web/src/dashboard/pages/EventsPage.tsx's `DEVICE_STATUS_MESSAGE`)
// renders for real, and that the go-live button is genuinely absent rather
// than merely disabled. Committed alongside drive-dashboard.mjs per fix
// round 1, Important 5.
//
// Usage: bun drive-dashboard-denied.mjs <token> <communityId> <sessionTitle> [webOrigin]
//
// REAL transcript from the run that produced Task 3's fix-round-1 report:
//   MESSAGE SHOWN: Izin kamera/mikrofon ditolak. Buka pengaturan situs di
//     peramban Anda (biasanya lewat ikon gembok di sebelah alamat situs),
//     izinkan akses Kamera dan Mikrofon untuk situs ini, lalu tekan "Coba lagi".
//   go-live buttons present while denied: 0

const token = process.argv[2];
const communityId = process.argv[3];
const sessionTitle = process.argv[4];
const webOrigin = process.argv[5] || "http://localhost:5173";

if (!token || !communityId || !sessionTitle) {
  console.error("usage: bun drive-dashboard-denied.mjs <token> <communityId> <sessionTitle> [webOrigin]");
  process.exit(1);
}

setTimeout(() => {
  console.log("HARD TIMEOUT");
  process.exit(1);
}, 30000);

import { chromium } from "playwright";

const browser = await chromium.launch({});
const context = await browser.newContext();
const page = await context.newPage();
page.on("pageerror", (err) => console.log("pageerror:", err.message));

await page.addInitScript(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    throw new DOMException("Permission denied", "NotAllowedError");
  };
});
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

await page.goto(`${webOrigin}/dashboard/c/${communityId}/streaming`, { waitUntil: "load" });
await page.waitForSelector("text=Siaran langsung", { timeout: 10000 });

const row = page.locator("tr", { hasText: sessionTitle });
await row.getByRole("button", { name: "Siarkan" }).click();
await page.getByRole("button", { name: /Aktifkan kamera/ }).click();

const el = await page.waitForSelector("text=Izin kamera/mikrofon ditolak", { timeout: 10000 });
const text = await el.textContent();
console.log("MESSAGE SHOWN:", text);

const goLiveButtons = await page.getByRole("button", { name: /Mulai siaran dari browser/ }).count();
console.log("go-live buttons present while denied:", goLiveButtons);

await browser.close();
const ok = goLiveButtons === 0 && text.includes("ditolak") && text.includes("gembok");
process.exit(ok ? 0 : 1);
