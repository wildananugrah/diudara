import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RENEWED } from "./use-cases/handle-payment-webhook";
import { CHURNED, CHURN_REVOKE_SKIPPED } from "./use-cases/process-churn";
import {
  RENEWAL_REMINDER_QUEUED,
  RENEWAL_REMINDER_SKIPPED,
} from "./use-cases/process-renewals";
import { ACCESS_NOT_REVOKED } from "./use-cases/revoke-channel-access";
import {
  RENEWAL_REMINDER_NOT_SENT,
  RENEWAL_REMINDER_SENT,
} from "./use-cases/send-renewal-reminder";

/**
 * I4, final whole-branch review. `activity_log` is Phase 6's declared source, and this
 * branch added seven event types to it — two of which describe ONE reminder, and one of
 * which (`renewed` against `joined`) is a hard-won distinction that took a race and a
 * measurement to get right. All of that lived only in a gitignored progress file, which
 * is to say nowhere a future reader would look.
 *
 * SO THIS TEST READS THE SPEC. Not for tidiness: the failure it prevents is Phase 6
 * counting `renewal_reminder_queued` and `renewal_reminder_sent` as two reminders, or
 * reading reminder volume out of `renewal_reminder` — whose rows are deleted on renewal
 * — and getting a number that is quietly wrong for ever. A contract nobody wrote down is
 * one the next phase invents for itself.
 *
 * It asserts against the EXPORTED CONSTANTS rather than string literals, so renaming an
 * event type in code fails here until the spec is updated with it.
 */

// src/application/ -> apps/api/ -> apps/ -> repo root
const REPO_ROOT = dirname(dirname(dirname(dirname(import.meta.dir))));
const SPEC_PATH = join(
  REPO_ROOT,
  "docs/superpowers/specs/2026-08-09-phase5-renewals-churn-design.md"
);

const spec = readFileSync(SPEC_PATH, "utf8");

/** Every `activity_log.event_type` this phase writes, from the code that writes it. */
const PHASE_5_EVENT_TYPES: Record<string, string> = {
  RENEWAL_REMINDER_QUEUED,
  RENEWAL_REMINDER_SENT,
  RENEWAL_REMINDER_SKIPPED,
  RENEWAL_REMINDER_NOT_SENT,
  CHURNED,
  CHURN_REVOKE_SKIPPED,
  ACCESS_NOT_REVOKED,
  RENEWED,
};

describe("the activity_log contract this phase hands to Phase 6", () => {
  it("documents every event type this phase writes", () => {
    const undocumented = Object.entries(PHASE_5_EVENT_TYPES)
      .filter(([, eventType]) => !spec.includes(`\`${eventType}\``))
      .map(([name, eventType]) => `${name} (${eventType})`);

    expect(undocumented).toEqual([]);
  });

  it("says that ONE reminder produces TWO rows, and which one means delivered", () => {
    // The single most likely way for Phase 6 to double every reminder figure.
    expect(spec).toMatch(/one reminder produces two rows/i);
    expect(spec).toContain(`\`${RENEWAL_REMINDER_SENT}\``);
    expect(spec).toMatch(/means "delivered"/i);
  });

  it("says that renewal_reminder rows are DELETED on renewal, so they are not a history", () => {
    // Reminder volume has to come from activity_log. A count over `renewal_reminder`
    // silently loses every period that was renewed.
    expect(spec).toMatch(/`renewal_reminder` rows are DELETED on renewal/i);
    expect(spec).toMatch(/must\s+therefore\s+come from `activity_log`/i);
  });

  it("distinguishes `renewed` from `joined`", () => {
    expect(spec).toMatch(new RegExp(`\`${RENEWED}\`[^\\n]*is not[^\\n]*\`joined\``, "i"));
  });

  it("keeps the schema pointing at the spec, so the table comment cannot become the only copy", () => {
    const schema = readFileSync(join(dirname(import.meta.dir), "db", "schema.ts"), "utf8");
    expect(schema).toMatch(/phase 6/i);
    // The pointer back to the spec, so the two cannot become two contracts.
    expect(schema).toContain("activity-log-contract.test.ts");
    expect(schema).toMatch(/one reminder produces two rows/i);
  });
});
