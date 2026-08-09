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

export interface RevokeInviteLinkInput {
  externalGroupId: string;
  /**
   * The link to kill AT THE PROVIDER. A bearer credential, so it may be used as a
   * request parameter and nothing else — never a log line, never an error message.
   */
  inviteLink: string;
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
  /**
   * Kills a link the provider has already minted, so it admits nobody.
   *
   * THE CREDENTIAL-LIFECYCLE INVARIANT depends on this method existing: at most one
   * live invite link per (member, channel) may exist at the provider at any time,
   * and every link that exists must be recorded in `channel_membership.invite_link`.
   * `grantAccess` mints a credential with an HTTP call and `recordGrant` records it
   * with a separate database write, so there is a window in which a link exists and
   * our record does not — and without a way to UNMINT, that window can only be
   * closed by leaking a live link nobody can revoke.
   *
   * Called best-effort: it runs when we are already handling a failure, so a second
   * failure here must be logged and swallowed rather than replacing the first. The
   * caller keeps the mint marker set in that case, which is what stops a retry from
   * minting a replacement on top of an orphan.
   *
   * MUST throw UnsupportedOperationError when capabilities().canGateAccess is
   * false, exactly like `grantAccess`.
   */
  revokeInviteLink(input: RevokeInviteLinkInput): Promise<void>;
  revokeAccess(input: RevokeAccessInput): Promise<void>;
  notify(input: NotifyInput): Promise<void>;
}
