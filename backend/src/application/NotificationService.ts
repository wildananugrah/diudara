import type { DomainEvent } from "../domain/events.ts";
import type {
  CommunityRepository, MembershipRepository, NotificationRepository,
  PostRepository, TierRepository, UserRepository,
} from "../domain/ports.ts";
import { NotFoundError } from "../domain/errors.ts";

/** One screen's worth, and a ceiling on what a single request can cost. */
const LIST_LIMIT = 50;

/**
 * Turns domain facts into rows addressed to the people they concern.
 *
 * This is the only subscriber on the event bus today. It is also the only place
 * that decides WHO hears about something — the emitting services announce that a
 * thing happened and are done, which is the whole point of routing this through
 * a bus (design spec 2026-09-17).
 *
 * Events carry ids; the display text is resolved here and stored on the row, so
 * a notification still reads correctly after the post it mentions is renamed.
 */
export class NotificationService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly users: UserRepository,
    private readonly communities: CommunityRepository,
    private readonly tiers: TierRepository,
    private readonly memberships: MembershipRepository,
    private readonly posts: PostRepository,
  ) {}

  /**
   * The bus calls this. It must not throw for anything short of a bug: the bus
   * swallows errors, but a notification failing is never a reason for the action
   * that caused it to look broken.
   */
  async handle(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case "post.commented": return this.onPostCommented(event);
      case "payment.confirmed": return this.onPaymentConfirmed(event);
      case "member.joined": return this.onMemberJoined(event);
      case "membership.ended": return this.onMembershipEnded(event);
      case "message.sent": return this.onMessageSent(event);
    }
  }

  private async onPostCommented(event: Extract<DomainEvent, { type: "post.commented" }>) {
    // Commenting on your own post is not news to you.
    if (event.actorId === event.postAuthorId) return;

    const [post, actor] = await Promise.all([
      this.posts.findById(event.postId),
      this.users.findById(event.actorId),
    ]);
    // A post deleted between the comment and this handler is a race, not an
    // error — and a row with no title to show is worse than no row.
    if (!post || !actor) return;

    await this.notifications.create({
      userId: event.postAuthorId,
      type: "post.commented",
      actorId: event.actorId,
      communityId: event.communityId,
      entityId: event.postId,
      data: { actorName: actor.name, postTitle: post.title, postType: post.type },
    });
  }

  private async onPaymentConfirmed(event: Extract<DomainEvent, { type: "payment.confirmed" }>) {
    const [community, tier] = await Promise.all([
      this.communities.findById(event.communityId),
      this.tiers.findById(event.tierId),
    ]);
    if (!community || !tier) return;

    await this.notifications.create({
      userId: event.userId,
      type: "payment.confirmed",
      communityId: event.communityId,
      entityId: event.paymentId,
      // Integer cents, like everywhere else — the frontend formats it.
      data: { communityName: community.name, tierName: tier.name, amountCents: tier.priceCents },
    });
  }

  private async onMemberJoined(event: Extract<DomainEvent, { type: "member.joined" }>) {
    const [community, tier, member, members] = await Promise.all([
      this.communities.findById(event.communityId),
      this.tiers.findById(event.tierId),
      this.users.findById(event.memberId),
      this.memberships.listMembers(event.communityId),
    ]);
    if (!community || !tier || !member) return;

    const recipients = members.filter((m) =>
      m.status === "active"
      && (m.role === "owner" || m.role === "admin")
      // An admin who subscribes to their own community hears about it once, as
      // the buyer — not a second time as staff.
      && m.userId !== event.memberId);

    for (const recipient of recipients) {
      await this.notifications.create({
        userId: recipient.userId,
        type: "member.joined",
        actorId: event.memberId,
        communityId: event.communityId,
        entityId: event.memberId,
        data: { actorName: member.name, communityName: community.name, tierName: tier.name },
      });
    }
  }

  private async onMembershipEnded(event: Extract<DomainEvent, { type: "membership.ended" }>) {
    const community = await this.communities.findById(event.communityId);
    if (!community) return;

    await this.notifications.create({
      userId: event.userId,
      type: "membership.ended",
      communityId: event.communityId,
      data: { communityName: community.name },
    });
  }

  private async onMessageSent(event: Extract<DomainEvent, { type: "message.sent" }>) {
    const sender = await this.users.findById(event.senderId);
    if (!sender) return;

    await this.notifications.create({
      userId: event.recipientId,
      type: "message.sent",
      actorId: event.senderId,
      entityId: event.conversationId,
      data: { actorName: sender.name, preview: event.preview },
    });
  }

  // ------------------------------------------------------------------ reading

  list(userId: string, filter: { unreadOnly?: boolean } = {}) {
    return this.notifications.listForUser(userId, { ...filter, limit: LIST_LIMIT });
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.notifications.countUnread(userId) };
  }

  /**
   * 404 rather than 403 for someone else's notification: whether that id exists
   * is not something a stranger should be able to confirm.
   */
  async markRead(id: string, userId: string): Promise<{ ok: true }> {
    const marked = await this.notifications.markRead(id, userId);
    if (!marked) throw new NotFoundError("Notifikasi");
    return { ok: true };
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(userId) };
  }
}
