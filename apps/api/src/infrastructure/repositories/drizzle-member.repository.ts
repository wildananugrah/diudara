import type { db as DbClient } from "../../db/client";
import { members } from "../../db/schema";
import type { MemberRecord, MemberRepositoryPort } from "../../application/ports/member-repository.port";

export class DrizzleMemberRepository implements MemberRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  /**
   * `member.whatsapp_number` is UNIQUE, so a second checkout from the same
   * number racing the first is the same shape as Phase 2's duplicate-email and
   * slug-collision TOCTOU 500s — both fixed by letting the database constraint
   * arbitrate rather than a pre-check. A single atomic UPSERT sidesteps the
   * race entirely: at most one statement can win the insert, and the other
   * lands on DO UPDATE instead of erroring, so `.returning()` always yields a
   * row either way.
   *
   * The DO UPDATE re-assigns the conflicting row's OWN whatsappNumber (not
   * `input.name`) so a repeat buyer's stored name is never silently overwritten
   * by whatever they happened to type on a later checkout — this only exists
   * to make the statement an UPDATE (and therefore RETURNING-eligible) rather
   * than a no-op.
   */
  async findOrCreateByWhatsappNumber(input: {
    whatsappNumber: string;
    name: string;
  }): Promise<MemberRecord> {
    const [row] = await this.db
      .insert(members)
      .values({ whatsappNumber: input.whatsappNumber, name: input.name })
      .onConflictDoUpdate({
        target: members.whatsappNumber,
        set: { whatsappNumber: input.whatsappNumber },
      })
      .returning();
    return row;
  }
}
