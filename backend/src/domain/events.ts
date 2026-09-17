/**
 * Facts that have already happened, announced by the service that made them
 * happen. Whoever cares subscribes; the emitter neither knows nor waits to find
 * out (see infrastructure/events/InProcessEventBus.ts).
 *
 * Events carry IDS, not sentences. The emitter says "this comment was written";
 * resolving who should hear about it, and in what words, belongs to the
 * subscriber — which is why CheckoutService does not need a community
 * repository just so a notification can say the community's name.
 *
 * A discriminated union rather than string constants, so a typo in an event
 * name or a missing field is a compile error on both sides.
 */
export type DomainEvent =
  | {
      type: "post.commented";
      postId: string;
      /** The recipient: whoever wrote the post being commented on. */
      postAuthorId: string;
      actorId: string;
      communityId: string;
    }
  | {
      type: "payment.confirmed";
      /** The recipient: whoever paid. */
      userId: string;
      communityId: string;
      tierId: string;
      paymentId: string;
    }
  | {
      /** Same moment as payment.confirmed, addressed to the other side of it. */
      type: "member.joined";
      communityId: string;
      memberId: string;
      tierId: string;
    }
  | {
      type: "membership.ended";
      /** The recipient: whoever lost access. */
      userId: string;
      communityId: string;
    }
  | {
      type: "message.sent";
      conversationId: string;
      senderId: string;
      /**
       * Resolved by the emitter, which already knows both participants — the
       * subscriber would need a second lookup to work it out again.
       */
      recipientId: string;
      preview: string;
    };

export type DomainEventType = DomainEvent["type"];

/** How much of a message body a notification preview carries. */
export const MESSAGE_PREVIEW_LENGTH = 80;
