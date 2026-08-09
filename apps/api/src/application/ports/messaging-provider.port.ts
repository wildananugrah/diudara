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
