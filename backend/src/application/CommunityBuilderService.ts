import type {
  BuilderMessage, BuilderTurn, CommunityBuilderAi, CommunityDraft,
  CommunityListItem, CommunityRepository, MembershipRepository, Tier, TierRepository,
} from "../domain/ports.ts";
import { ValidationError } from "../domain/errors.ts";

/** Palette from frontend/src/styles/tokens.css — the UI renders these verbatim. */
const COLORS = ["var(--langit)", "var(--sinyal)", "var(--hijau-lepas)", "var(--merah-senja)"];

const MAX_TURNS = 40;
const MAX_MESSAGE_CHARS = 2000;

/**
 * Turns a conversation into a real community.
 *
 * Deliberately separate from CommunityService: that one reads and this one
 * writes through a different set of collaborators (AI + tiers + memberships).
 * Merging them would hand every discovery query an AI client it never uses (ISP).
 */
export class CommunityBuilderService {
  constructor(
    private readonly ai: CommunityBuilderAi,
    private readonly communities: CommunityRepository,
    private readonly memberships: MembershipRepository,
    private readonly tiers: TierRepository,
  ) {}

  /**
   * One conversation turn. The whole transcript comes from the client each time
   * — the API keeps no session — so it is bounded here to stop a caller from
   * running up an unbounded OpenRouter bill through one request.
   */
  async chat(messages: unknown): Promise<BuilderTurn> {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ValidationError("Percakapan kosong");
    }
    if (messages.length > MAX_TURNS) {
      throw new ValidationError("Percakapan terlalu panjang. Mulai ulang obrolan.");
    }

    const clean: BuilderMessage[] = messages.map((m, i) => {
      const msg = m as { role?: unknown; content?: unknown };
      if (msg.role !== "user" && msg.role !== "assistant") {
        throw new ValidationError(`Pesan ke-${i + 1} punya role yang tidak valid`);
      }
      if (typeof msg.content !== "string" || !msg.content.trim()) {
        throw new ValidationError(`Pesan ke-${i + 1} kosong`);
      }
      if (msg.content.length > MAX_MESSAGE_CHARS) {
        throw new ValidationError(`Pesan ke-${i + 1} terlalu panjang`);
      }
      return { role: msg.role, content: msg.content };
    });

    return this.ai.next(clean);
  }

  /**
   * Creates the community, its tiers, and the owner membership.
   *
   * `draft` arrives from the browser. Even though the AI produced it, it reached
   * us through the client and is validated here as ordinary user input — the
   * model is a convenience, never the authority on what may be written.
   */
  async create(ownerId: string, draft: unknown): Promise<CommunityListItem & { tiers: Tier[] }> {
    const d = CommunityBuilderService.validate(draft);

    const id = await this.freeSlug(d.name);
    // validate() guarantees at least one tier.
    const first = d.tiers[0]!;

    const community = await this.communities.create({
      id,
      name: d.name,
      niche: d.niche,
      category: d.category,
      description: d.description,
      // Deterministic rather than random so a re-created community keeps its look.
      color: COLORS[id.length % COLORS.length]!,
      // The card price is the cheapest tier — what Discover.tsx shows as "mulai dari".
      priceCents: first.priceCents,
      billingPeriod: first.billingPeriod,
      ownerId,
    });

    const tiers = await this.tiers.createMany(id, d.tiers);

    // Without this the creator could not post or open their own dashboard:
    // every community route authorises through community_members, not ownerId.
    await this.memberships.upsert({
      communityId: id, userId: ownerId, role: "owner", status: "active", tierId: null,
    });

    // Re-read: memberCount is a computed column, and the owner only became a
    // member on the line above — `community` still says 0.
    const fresh = await this.communities.findById(id);
    return { ...(fresh ?? community), tiers };
  }

  /** Appends -2, -3 … until the slug is free. */
  private async freeSlug(name: string): Promise<string> {
    const base = CommunityBuilderService.slugify(name);
    if (!(await this.communities.exists(base))) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base}-${n}`;
      if (!(await this.communities.exists(candidate))) return candidate;
    }
    throw new ValidationError("Nama komunitas ini sudah terlalu banyak dipakai. Pilih nama lain.");
  }

  /** Slug is the primary key AND the public URL (/community/<slug>), so: ASCII only. */
  static slugify(name: string): string {
    const slug = name
      .normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "");
    // Non-Latin names (e.g. all-emoji) can slugify to nothing; never insert "".
    return slug || `komunitas-${Date.now().toString(36)}`;
  }

  private static str(value: unknown, field: string, { min, max }: { min: number; max: number }): string {
    if (typeof value !== "string") throw new ValidationError(`${field} wajib diisi`);
    const trimmed = value.trim();
    if (trimmed.length < min) throw new ValidationError(`${field} minimal ${min} karakter`);
    if (trimmed.length > max) throw new ValidationError(`${field} maksimal ${max} karakter`);
    return trimmed;
  }

  private static cents(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ValidationError(`${field} harus berupa angka`);
    }
    const n = Math.round(value);
    if (n < 0) throw new ValidationError(`${field} tidak boleh negatif`);
    // Rp1.000.000.000. Above this it is a unit mistake (rupiah vs cents), not a price.
    if (n > 100_000_000_000) throw new ValidationError(`${field} terlalu besar`);
    return n;
  }

  private static validate(raw: unknown): Required<Omit<CommunityDraft, "priceCents" | "tiers">> & {
    tiers: Array<{ name: string; priceCents: number; billingPeriod: string; benefits: string[]; highlight: boolean }>;
  } {
    if (typeof raw !== "object" || raw === null) throw new ValidationError("Data komunitas tidak valid");
    const d = raw as CommunityDraft;

    const tiersIn = Array.isArray(d.tiers) ? d.tiers : [];
    if (tiersIn.length === 0) throw new ValidationError("Minimal satu paket membership");
    if (tiersIn.length > 5) throw new ValidationError("Maksimal lima paket membership");

    const tiers = tiersIn.map((t, i) => {
      if (typeof t !== "object" || t === null) throw new ValidationError(`Paket ke-${i + 1} tidak valid`);
      const benefitsIn = Array.isArray(t.benefits) ? t.benefits : [];
      if (benefitsIn.length > 10) throw new ValidationError(`Paket ke-${i + 1} maksimal 10 benefit`);
      return {
        name: CommunityBuilderService.str(t.name, `Nama paket ke-${i + 1}`, { min: 1, max: 60 }),
        priceCents: CommunityBuilderService.cents(t.priceCents, `Harga paket ke-${i + 1}`),
        billingPeriod: typeof t.billingPeriod === "string" && t.billingPeriod.trim()
          ? t.billingPeriod.trim().slice(0, 20)
          : "/ bulan",
        benefits: benefitsIn
          .filter((b): b is string => typeof b === "string" && Boolean(b.trim()))
          .map((b) => b.trim().slice(0, 200)),
        highlight: t.highlight === true,
      };
    });

    return {
      name: CommunityBuilderService.str(d.name, "Nama komunitas", { min: 3, max: 80 }),
      niche: CommunityBuilderService.str(d.niche, "Fokus komunitas", { min: 3, max: 120 }),
      category: CommunityBuilderService.str(d.category, "Kategori", { min: 2, max: 40 }),
      description: CommunityBuilderService.str(d.description, "Deskripsi", { min: 10, max: 2000 }),
      billingPeriod: tiers[0]!.billingPeriod,
      tiers,
    };
  }
}
