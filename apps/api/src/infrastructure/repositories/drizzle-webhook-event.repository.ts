import type { db as DbClient } from "../../db/client";
import { webhookEvents } from "../../db/schema";
import type { WebhookEventRepositoryPort } from "../../application/ports/webhook-event-repository.port";

export class DrizzleWebhookEventRepository implements WebhookEventRepositoryPort {
  constructor(private readonly db: typeof DbClient) {}

  /**
   * One statement, and the DATABASE decides. `INSERT ... ON CONFLICT DO NOTHING
   * ... RETURNING` returns a row only for the caller that actually inserted, so
   * `rows.length > 0` is a truthful "I am the one who must process this event"
   * even with several Xendit retries in flight at once.
   *
   * Do NOT rewrite this as `select` then `insert`: both callers would see no row,
   * both would decide to process, and the loser would 500 on
   * `webhook_event_provider_event_id_unique` after the first had already
   * activated the subscription.
   */
  async recordIfNew(input: {
    provider: string;
    providerEventId: string;
    eventType: string;
    payload: unknown;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(webhookEvents)
      .values({
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: webhookEvents.providerEventId })
      .returning({ id: webhookEvents.id });

    return rows.length > 0;
  }
}
