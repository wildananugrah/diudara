export interface MessagingCapabilities {
  /**
   * Whether this provider can actually add and remove members from a group.
   * False for WhatsApp: Meta's official Groups API has no POST /participants
   * and caps groups at 8 members, and unofficial gateways would risk the
   * CREATOR's account. See spec §2.1.
   */
  canGateAccess: boolean;
}

export interface GrantAccessInput {
  externalGroupId: string;
  memberWhatsappNumber: string;
  /**
   * The provider-specific member id recorded the LAST time this member had
   * access to this group, when there was one. Absent for a first-ever grant,
   * where no such id can exist.
   *
   * It exists because of a Telegram rule that is easy to miss and produces a
   * confusing failure: `banChatMember` (how `revokeAccess` removes someone) also
   * blocks them from joining by ANY invite link, so a churned member who
   * re-pays gets a link that silently does not work until they are unbanned —
   * and `unbanChatMember` needs their user id. Nothing else in `GrantAccessInput`
   * carries one: at grant time all we know is a WhatsApp number, which is
   * precisely why access is granted with a link rather than by adding the member.
   *
   * Optional, and provider-specific by design: a provider with no ban concept
   * ignores it, and the ordering rule ("unban BEFORE issuing the link") lives in
   * the adapter that has the rule, not in a use-case.
   */
  previousExternalMemberId?: string;
}

export interface RevokeAccessInput {
  externalGroupId: string;
  /** Provider-specific member identifier recorded at grant time. */
  externalMemberId: string;
}

export interface NotifyInput {
  toWhatsappNumber: string;
  message: string;
}

export interface MessagingProviderPort {
  readonly platform: string;
  capabilities(): MessagingCapabilities;
  /**
   * Issues a single-use, expiring invite. MUST throw UnsupportedOperationError
   * when capabilities().canGateAccess is false — a silent no-op would leave a
   * paying member believing they were granted access.
   */
  grantAccess(input: GrantAccessInput): Promise<{ inviteLink: string }>;
  revokeAccess(input: RevokeAccessInput): Promise<void>;
  notify(input: NotifyInput): Promise<void>;
}
