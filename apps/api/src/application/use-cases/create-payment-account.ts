import { ConflictError, NotFoundError } from "../errors";
import type { CreatorRepositoryPort } from "../ports/creator-repository.port";
import type { PaymentProviderPort } from "../ports/payment-provider.port";

export class CreatePaymentAccount {
  constructor(
    private readonly creators: CreatorRepositoryPort,
    private readonly payments: PaymentProviderPort
  ) {}

  async execute(creatorId: string): Promise<{ xenditAccountId: string }> {
    const creator = await this.creators.findById(creatorId);
    if (!creator) {
      throw new NotFoundError("creator not found");
    }
    if (creator.xenditAccountId) {
      throw new ConflictError("payment account already connected");
    }
    if (!creator.email) {
      throw new ConflictError("an email address is required to connect payments");
    }

    const { accountId } = await this.payments.createPaymentAccount({
      creatorId: creator.id,
      email: creator.email,
      name: creator.name,
    });

    await this.creators.setXenditAccountId(creator.id, accountId);
    return { xenditAccountId: accountId };
  }
}
