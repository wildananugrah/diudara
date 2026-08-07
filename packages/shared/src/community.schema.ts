import { z } from "zod";

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric words separated by single hyphens");

export const createCommunitySchema = z.object({
  name: z.string().trim().min(1).max(255),
  niche: z.string().trim().max(128).optional(),
});

export const updateCommunitySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    niche: z.string().trim().max(128).optional(),
    slug: slug.optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const createTierSchema = z.object({
  name: z.string().trim().min(1).max(128),
  priceAmount: z.number().int().min(0),
  billingCycle: z.enum(["monthly", "quarterly", "yearly"]),
});

export const updateTierSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    priceAmount: z.number().int().min(0).optional(),
    billingCycle: z.enum(["monthly", "quarterly", "yearly"]).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "at least one field is required" });

export const connectChannelSchema = z.object({
  platform: z.enum(["whatsapp", "telegram"]),
  externalGroupId: z.string().trim().min(1).max(255),
});

export type CreateCommunityInput = z.infer<typeof createCommunitySchema>;
export type UpdateCommunityInput = z.infer<typeof updateCommunitySchema>;
export type CreateTierInput = z.infer<typeof createTierSchema>;
export type UpdateTierInput = z.infer<typeof updateTierSchema>;
export type ConnectChannelInput = z.infer<typeof connectChannelSchema>;
