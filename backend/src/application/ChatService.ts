import type {
  ConversationRepository, MessageRepository, UploadRepository, UserRepository, EventBus,
} from "../domain/ports.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { MESSAGE_PREVIEW_LENGTH } from "../domain/events.ts";
import { assertUploadsExist } from "./PostService.ts";

export class ChatService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly users: UserRepository,
    private readonly uploads: UploadRepository,
    private readonly events: EventBus,
  ) {}

  list(userId: string) { return this.conversations.listForUser(userId); }

  /** Idempotent per pair — reopening a DM reuses the existing thread. */
  async openDirect(userId: string, peerId: string) {
    if (peerId === userId) throw new ValidationError("Tidak bisa memulai chat dengan diri sendiri");
    if (!(await this.users.findById(peerId))) throw new NotFoundError("Pengguna");
    return this.conversations.findOrCreateDirect(userId, peerId);
  }

  private otherParticipant(conversationId: string, userId: string) {
    return this.conversations.otherParticipant(conversationId, userId);
  }

  private async assertParticipant(conversationId: string, userId: string) {
    if (!(await this.conversations.isParticipant(conversationId, userId))) {
      // 403, not 404: the conversation exists, the caller simply isn't in it.
      throw new ForbiddenError("Kamu bukan peserta percakapan ini");
    }
  }

  async messagesFor(conversationId: string, userId: string) {
    await this.assertParticipant(conversationId, userId);
    const rows = await this.messages.listForConversation(conversationId);
    // "me"/"them" is what the UI renders against, so resolve it server-side
    // rather than leaking every sender id to the client.
    return rows.map(({ senderId, ...m }) => ({ ...m, sender: senderId === userId ? "me" : "them" }));
  }

  async send(conversationId: string, userId: string, input: { text: string; attachmentIds?: string[] }) {
    await this.assertParticipant(conversationId, userId);
    if (!input.text?.trim() && !input.attachmentIds?.length) {
      throw new ValidationError("Pesan tidak boleh kosong");
    }
    await assertUploadsExist(this.uploads, input.attachmentIds);
    const msg = await this.messages.create({
      conversationId, senderId: userId,
      body: input.text?.trim() ?? "", attachmentIds: input.attachmentIds,
    });

    // The recipient is resolved here, where both participants are already known —
    // the subscriber would have to look the conversation up again to find them.
    const recipientId = await this.otherParticipant(conversationId, userId);
    if (recipientId) {
      await this.events.emit({
        type: "message.sent",
        conversationId,
        senderId: userId,
        recipientId,
        preview: (input.text?.trim() ?? "").slice(0, MESSAGE_PREVIEW_LENGTH),
      });
    }

    return { ...msg, sender: "me" as const };
  }

  async markRead(conversationId: string, userId: string) {
    await this.assertParticipant(conversationId, userId);
    await this.conversations.markRead(conversationId, userId);
    return { ok: true };
  }
}
