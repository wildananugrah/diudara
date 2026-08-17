import { z } from "zod";

const email = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(8).max(200);

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(255),
  email,
  password,
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * `POST /users/signup` — a member/creator's PERSONAL account, distinct from
 * the creator-only `signupSchema` above. `handle` allows up to 31 characters
 * here (not the domain's 30) so a leading `@` a caller pasted in survives
 * validation; `normalizeHandle` strips it before the domain's 3-30 rule
 * (`isValidHandle`) is enforced on the normalised value. The WhatsApp regex
 * is copied FIELD FOR FIELD from `startCheckoutSchema` (tolerant of a
 * leading 0 or +62) so the two forms never disagree about what counts as a
 * valid number.
 */
export const userSignupSchema = z.object({
  handle: z.string().trim().min(1).max(31),
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(255),
  whatsappNumber: z.string().trim().min(8).max(20).regex(/^[+0-9][0-9]{7,19}$/).optional(),
});

export const userLoginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

export type UserSignupInput = z.infer<typeof userSignupSchema>;
export type UserLoginInput = z.infer<typeof userLoginSchema>;
