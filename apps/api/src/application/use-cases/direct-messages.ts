import { MAX_MESSAGE_BODY_LENGTH } from "@diudara/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { normalizeHandle } from "../../domain/handle";
import type {
  ConversationRepositoryPort,
  ConversationRow,
  DirectMessageRow,
} from "../ports/conversation-repository.port";
import type { CommunityRepositoryPort } from "../ports/community-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";

/** One screen of a thread. A conversation is read, not paged, at this size. */
const DEFAULT_MESSAGE_LIMIT = 100;

export interface ConversationView {
  id: string;
  other: { handle: string; displayName: string };
  lastMessageBody: string | null;
  /** ISO-8601, or null on a conversation nobody has spoken in. */
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface DirectMessageView {
  id: string;
  senderHandle: string;
  body: string;
  /** ISO-8601. */
  createdAt: string;
}

function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    other: { handle: row.otherHandle, displayName: row.otherDisplayName },
    lastMessageBody: row.lastMessageBody,
    lastMessageAt: row.lastMessageAt === null ? null : row.lastMessageAt.toISOString(),
    unreadCount: row.unreadCount,
  };
}

function toMessageView(row: DirectMessageRow): DirectMessageView {
  return {
    id: row.id,
    senderHandle: row.senderHandle,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `GET /users/me/conversations`. */
export class ListConversations {
  constructor(private readonly conversations: ConversationRepositoryPort) {}

  async execute(input: { viewerId: string }): Promise<{ conversations: ConversationView[] }> {
    const rows = await this.conversations.listFor(input.viewerId);
    return { conversations: rows.map(toConversationView) };
  }
}

/**
 * `POST /users/me/conversations` — start one, or return the one that exists.
 *
 * **THE RULE: you may only open a conversation with somebody you share a
 * community with.** A product with open signup and open DMs has a spam
 * problem it did not choose, and this is where the reference opens chat from
 * — a member's row inside a community.
 *
 * **The check runs on CREATION and never on sending**, and that asymmetry is
 * deliberate: closing a thread because somebody later left a community would
 * strand it mid-sentence, and a person you have been talking to is not
 * thereby a stranger. `SendDirectMessage` below therefore asks only whether
 * you are a participant.
 *
 * IDEMPOTENT: opening a chat with somebody you already have a thread with
 * returns it. The client's flow is "message this person" and it should not
 * have to know whether that thread exists.
 */
export class StartConversation {
  constructor(
    private readonly conversations: ConversationRepositoryPort,
    private readonly users: UserRepositoryPort,
    private readonly communities: CommunityRepositoryPort
  ) {}

  async execute(input: { viewerId: string; handle: string }): Promise<{ id: string }> {
    // `normalizeHandle` for the forgiveness every handle-taking path gives:
    // the `@` is a URL convention, not a typo.
    const other = await this.users.findByHandle(normalizeHandle(input.handle));
    if (other === null) throw new NotFoundError("pengguna tidak ditemukan");

    // Refused here rather than left to `conversation_ordered_pair`. The CHECK
    // is the backstop and would surface as a 500, which is not something a
    // person can act on.
    if (other.id === input.viewerId) {
      throw new ValidationError("Anda tidak dapat mengirim pesan ke diri sendiri.");
    }

    // EXISTING FIRST, and the gate only guards creation. Reopening a thread
    // you already have must work even after one of you has left the community
    // you met in — that is the same asymmetry `SendDirectMessage` relies on,
    // and checking the gate before this lookup would have broken it for the
    // one endpoint a client actually calls to open a chat.
    const existing = await this.conversations.findBetween(input.viewerId, other.id);
    if (existing !== null) return existing;

    if (!(await this.communities.sharesCommunityWith(input.viewerId, other.id))) {
      throw new ForbiddenError(
        "Anda hanya dapat mengirim pesan ke sesama anggota komunitas yang sama."
      );
    }

    return this.conversations.findOrCreateBetween(input.viewerId, other.id);
  }
}

/**
 * The participant gate, shared by the three `:id` routes.
 *
 * **A non-participant gets `NotFoundError`, never `ForbiddenError`** — the
 * rule the media and document gates already follow. A 403 would confirm that
 * a conversation with that id exists, which is exactly what somebody probing
 * ids wants to learn.
 */
async function requireParticipant(
  conversations: ConversationRepositoryPort,
  conversationId: string,
  viewerId: string
): Promise<void> {
  const found = await conversations.findParticipating(conversationId, viewerId);
  if (found === null) throw new NotFoundError("percakapan tidak ditemukan");
}

/** `GET /users/me/conversations/:id/messages`. */
export class ListDirectMessages {
  constructor(private readonly conversations: ConversationRepositoryPort) {}

  async execute(input: {
    viewerId: string;
    conversationId: string;
    limit?: number;
  }): Promise<{ messages: DirectMessageView[] }> {
    await requireParticipant(this.conversations, input.conversationId, input.viewerId);
    const rows = await this.conversations.listMessages(
      input.conversationId,
      input.limit ?? DEFAULT_MESSAGE_LIMIT
    );
    return { messages: rows.map(toMessageView) };
  }
}

/**
 * `POST /users/me/conversations/:id/messages`.
 *
 * Asks ONLY whether you are a participant — never whether you still share a
 * community. See `StartConversation` for why that asymmetry is the rule.
 */
export class SendDirectMessage {
  constructor(private readonly conversations: ConversationRepositoryPort) {}

  async execute(input: {
    viewerId: string;
    conversationId: string;
    body: string;
  }): Promise<DirectMessageView> {
    await requireParticipant(this.conversations, input.conversationId, input.viewerId);

    const body = input.body.trim();
    if (body.length === 0) throw new ValidationError("Pesan tidak boleh kosong.");
    if (body.length > MAX_MESSAGE_BODY_LENGTH) {
      throw new ValidationError(`Pesan maksimal ${MAX_MESSAGE_BODY_LENGTH} karakter.`);
    }

    return toMessageView(
      await this.conversations.send(input.conversationId, input.viewerId, body)
    );
  }
}

/** `POST /users/me/conversations/:id/read` — moves THIS viewer's mark only. */
export class MarkConversationRead {
  constructor(private readonly conversations: ConversationRepositoryPort) {}

  async execute(input: { viewerId: string; conversationId: string }): Promise<{ read: true }> {
    await requireParticipant(this.conversations, input.conversationId, input.viewerId);
    await this.conversations.markRead(input.conversationId, input.viewerId);
    return { read: true };
  }
}
