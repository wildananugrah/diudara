export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain text only. HTML mail is a rendering and deliverability project of its own. */
  body: string;
}

export interface EmailProviderPort {
  send(input: SendEmailInput): Promise<void>;
}
