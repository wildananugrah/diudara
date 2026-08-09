/**
 * Reads Telegram's `chat_member` update, and nothing else.
 *
 * This is the ONLY thing that lets revocation work. `banChatMember` addresses a
 * Telegram integer user id, and Phase 4 grants access with an INVITE LINK
 * precisely because it does not know one — checkout knows a WhatsApp number. The
 * id only becomes knowable at the moment the member joins, and Telegram reports
 * that in a `chat_member` update which carries the `invite_link` that was used.
 * Since Phase 4 issues a SINGLE-USE link per member, that link is the join key
 * back to exactly one `channel_membership` row.
 *
 * Shaped like `xendit-webhook-payload.ts` and for the same reason: the body is
 * untrusted, so every field is checked before it is believed, and nothing here
 * ever puts the invite link in an error message — it is a bearer credential (plan,
 * Global Constraints).
 *
 * !!! Written from Telegram's published Bot API documentation, with no bot token
 * to verify it against — the same honest limitation TelegramBotAdapter carries.
 * The shape below is an ASSUMPTION about the wire format. What the tests beside
 * this file prove is that a body of THIS shape is read correctly and that
 * everything else is ignored safely; they do not prove Telegram sends it.
 */

/** The one thing this module extracts. */
export interface TelegramChatMemberJoin {
  /** `chat.id`, stringified — it is a (usually negative) integer on the wire. */
  chatId: string;
  /** `new_chat_member.user.id`, stringified. What `banChatMember` needs. */
  externalMemberId: string;
  /**
   * The link the member used. A BEARER CREDENTIAL: it is the lookup key and it
   * must never reach a log line, an error message or a response.
   */
  inviteLink: string;
}

/**
 * `new_chat_member.status` values that mean "this user is now IN the chat".
 *
 * An allowlist, like `VISIBLE_STATUSES` and `RELAXED_NODE_ENVS`, for the same
 * reason: a status Telegram adds later must not be read as a join. `left` and
 * `kicked` are the departures this excludes — recording a user id from a LEAVE
 * would be harmless today but is not what this claims to do.
 *
 * `restricted` is handled separately below: it means "in the chat" only when
 * `is_member` is true, which is a documented quirk rather than something the
 * status string alone says.
 */
const JOINED_STATUSES: ReadonlySet<string> = new Set(["member", "administrator", "creator"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The cap on the inbound link, matching `channel_membership.invite_link`'s
 * varchar(512).
 *
 * Bounded here rather than left to the database: this value comes off an untrusted
 * body and is used as a LOOKUP KEY, so an unbounded string is a megabyte of
 * attacker-chosen text handed to an index scan on every delivery. A real `t.me/+…`
 * link is well under a hundred characters, so nothing legitimate is near this. A
 * MISS rather than an error, like every other rejection in this module: Telegram
 * retries anything that is not a 2xx, and no retry makes an over-long link valid.
 */
const MAX_INVITE_LINK_LENGTH = 512;

/**
 * Telegram ids are integers, and large ones (channel ids are around -1e12). They
 * arrive as JSON numbers, so a value outside the safe integer range has already
 * been corrupted by the parser and must be refused rather than stringified.
 */
function integerIdToString(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return null;
  }
  return String(value);
}

function isInChat(newChatMember: Record<string, unknown>): boolean {
  const status = newChatMember.status;
  if (typeof status !== "string") return false;
  if (JOINED_STATUSES.has(status)) return true;
  return status === "restricted" && newChatMember.is_member === true;
}

/**
 * Returns the join, or **null** for anything else — a `message`, a
 * `my_chat_member`, a departure, a join with no invite link (someone added by an
 * admin by hand), or a body that does not match the shape above at all.
 *
 * `null` rather than a throw, deliberately. Telegram retries an update it did not
 * get a 2xx for, and none of these cases becomes valid on a retry: a 4xx would
 * make it redeliver the same unusable update indefinitely. The caller answers 2xx
 * and does nothing.
 */
export function parseTelegramChatMemberJoin(body: unknown): TelegramChatMemberJoin | null {
  if (!isRecord(body)) return null;

  const update = body.chat_member;
  if (!isRecord(update)) return null;

  const newChatMember = update.new_chat_member;
  if (!isRecord(newChatMember) || !isInChat(newChatMember)) return null;

  const user = newChatMember.user;
  if (!isRecord(user)) return null;
  const externalMemberId = integerIdToString(user.id);
  if (externalMemberId === null) return null;

  const chat = update.chat;
  if (!isRecord(chat)) return null;
  const chatId = integerIdToString(chat.id);
  if (chatId === null) return null;

  // The join key. Absent for a member an admin added by hand or who used the
  // chat's primary link — real, and nothing to attach an id to, so it is a miss
  // rather than an error.
  const link = update.invite_link;
  if (!isRecord(link)) return null;
  const inviteLink = link.invite_link;
  if (
    typeof inviteLink !== "string" ||
    inviteLink.length === 0 ||
    inviteLink.length > MAX_INVITE_LINK_LENGTH
  ) {
    return null;
  }

  return { chatId, externalMemberId, inviteLink };
}
