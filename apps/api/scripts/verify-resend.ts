/**
 * One-off operator script: send a REAL email through the REAL adapter.
 *
 * `resend-email.adapter.ts` carries a warning saying it has never been
 * exercised against the live Resend API — it was written from published
 * documentation without an account, so its request shape and error handling
 * are assumptions. That file asks whoever first runs it against a real
 * account to verify it and then delete the warning. This is that check.
 *
 * It constructs `ResendEmailAdapter` exactly as `bootstrap.ts` does and calls
 * the same `send()` the password reset calls. A mock would prove only that
 * the mock works; the whole point here is the network hop nothing else has
 * ever made.
 *
 *   cd apps/api
 *   bun --env-file=.env run scripts/verify-resend.ts you@example.com
 *
 * THIS SENDS A REAL EMAIL. The recipient is a required argument precisely so
 * that running the file by accident cannot send anything.
 *
 * On failure it runs a second, DIRECT request to the same endpoint and prints
 * Resend's own error body. The adapter deliberately withholds that body — a
 * credential reached a log that way once in Phase 2 — which is right for
 * production and useless for diagnosis, so the detail lives here, in a script
 * an operator runs by hand, instead of being loosened in the adapter. The key
 * itself is never printed by either path.
 */
import { ResendEmailAdapter } from "../src/infrastructure/email/resend-email.adapter";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const to = process.argv[2];
if (to === undefined || to.trim() === "") {
  fail(
    "Usage: bun --env-file=.env run scripts/verify-resend.ts <recipient@example.com>\n" +
      "  The recipient is required — this sends a real email."
  );
}

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.EMAIL_FROM;

// The same "both or neither" rule bootstrap.ts enforces, reported here in the
// operator's terms rather than as a boot failure.
if (!apiKey || !from) {
  const missing = [!apiKey && "RESEND_API_KEY", !from && "EMAIL_FROM"].filter(Boolean).join(" and ");
  fail(
    `${missing} is not set in apps/api/.env.\n` +
      "  Both are required — bootstrap.ts throws on one without the other, in every environment."
  );
}

/** Never the key itself: shape and length are enough to spot a truncated paste. */
function describeKey(key: string): string {
  const shape = key.startsWith("re_") ? 'starts with "re_"' : `starts with ${JSON.stringify(key.slice(0, 3))} — Resend keys start with "re_"`;
  return `${key.length} chars, ${shape}`;
}

console.log("\n  Sending through ResendEmailAdapter — the real one, over the real network.\n");
console.log(`    from    ${from}`);
console.log(`    to      ${to}`);
console.log(`    key     ${describeKey(apiKey)}`);
console.log("");

const subject = "DIUDARA — verifikasi pengiriman email";
const body =
  "Ini email uji dari DIUDARA.\n\n" +
  "Jika Anda menerima pesan ini, pengiriman email sudah berfungsi dan " +
  "pemulihan sandi bisa diandalkan.\n\n" +
  `Dikirim pada ${new Date().toISOString()}.`;

try {
  await new ResendEmailAdapter({ apiKey, from }).send({ to, subject, body });
  console.log("  SENT — the adapter reported success.\n");
  console.log("  Now check the inbox. A 200 from Resend means ACCEPTED, not DELIVERED:");
  console.log("  SPF/DKIM problems and spam filtering both happen after this point.");
  console.log("  Once a message actually arrives, delete the UNVERIFIED warning at the top");
  console.log("  of src/infrastructure/email/resend-email.adapter.ts — it has earned it.\n");
  process.exit(0);
} catch (error) {
  console.error(`  FAILED: ${(error as Error).message}\n`);
  console.error("  Asking Resend directly for the reason it withheld:\n");

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text: body }),
      signal: AbortSignal.timeout(30_000),
    });
    console.error(`    HTTP ${response.status} ${response.statusText}`);
    console.error(`    ${(await response.text()).trim() || "(empty body)"}\n`);

    if (response.status === 401 || response.status === 403) {
      console.error("  401/403 is usually one of two things, and they look identical:");
      console.error("    - the domain in EMAIL_FROM is not verified in your Resend dashboard");
      console.error("    - the API key is wrong, revoked, or lacks sending permission\n");
      console.error("  To separate them, set EMAIL_FROM to onboarding@resend.dev and send to the");
      console.error("  address you registered with. That pair needs no domain setup: if it works,");
      console.error("  the key is fine and the problem is domain verification.\n");
    }
  } catch (probeError) {
    console.error(`    the direct probe also failed: ${(probeError as Error).message}`);
    console.error("    that points at network or DNS from this host, not at Resend.\n");
  }
  process.exit(1);
}
