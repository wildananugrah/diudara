/**
 * The audit trail required by the Phase 1 plan's constraint: "every
 * membership/status-changing action must write an `activity_log` entry". Task 7
 * is its first real writer.
 *
 * `memberId` is nullable because the table supports community-scoped events with
 * no member attached; `communityId` is not, because every event belongs to
 * exactly one community.
 */
export interface ActivityLogRepositoryPort {
  record(input: {
    memberId: string | null;
    communityId: string;
    eventType: string;
    /**
     * Stored as jsonb. Keep provider payloads OUT of here — a Xendit callback
     * carries the payer's name and email, and this table is read by dashboards.
     * The raw payload already has one home, `webhook_event.payload`.
     */
    metadata?: unknown;
  }): Promise<void>;
}
