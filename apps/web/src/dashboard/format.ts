/**
 * Every string the dashboard formats, in one place so the wording is testable
 * without a browser — the same reason the API keeps its activity labels in a pure
 * domain module.
 *
 * Labels are INDONESIAN. Every member-facing string in this product is, and the
 * dashboard is for Indonesian creators.
 */
import { formatRupiah } from "../api";

export { formatRupiah };

/** `monthly` -> "per bulan". Unknown cycles pass through rather than being hidden. */
export function billingCycleLabel(cycle: string): string {
  switch (cycle) {
    case "monthly":
      return "per bulan";
    case "quarterly":
      return "per 3 bulan";
    case "yearly":
      return "per tahun";
    default:
      return cycle;
  }
}

/**
 * The same cycles as an adjective, for a `<select>`.
 *
 * Deliberately different words from `billingCycleLabel`: "per bulan" reads as a
 * price suffix ("Rp 50.000 per bulan") and "Bulanan" reads as a choice. They are
 * also the reason a test can tell a table cell apart from a form option.
 */
export function billingCycleOptionLabel(cycle: string): string {
  switch (cycle) {
    case "monthly":
      return "Bulanan";
    case "quarterly":
      return "Setiap 3 bulan";
    case "yearly":
      return "Tahunan";
    default:
      return cycle;
  }
}

export function platformLabel(platform: string): string {
  switch (platform) {
    case "telegram":
      return "Telegram";
    case "whatsapp":
      return "WhatsApp";
    default:
      return platform;
  }
}

export function communityStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "paused":
      return "Dijeda";
    case "archived":
      return "Diarsipkan";
    default:
      return status;
  }
}

/**
 * `updateCommunitySchema`/`createCommunitySchema`'s `accessMode` enum. Offering
 * anything else earns a 400.
 *
 * Lives here, beside the two functions that describe these values, because BOTH
 * the create form (`CommunitiesPage`) and the settings form
 * (`CommunityOverviewPage`) render a select over it — and a second copy is how
 * the two silently stop offering the same set.
 */
export const ACCESS_MODES = ["paid", "request"] as const;

/**
 * What the create form offers when the SERVER has no payment provider: the only
 * value `CreateCommunity` will accept there. Named rather than inlined so the
 * relationship to `ACCESS_MODES` above is visible at both call sites.
 */
export const REQUEST_ONLY = ["request"] as const;

/**
 * `community.access_mode` value whose join path is a request, not a purchase.
 *
 * Exported because four screens' COPY depends on it, not just their behaviour:
 * a request-mode community has no checkout, no price and no payment, so every
 * sentence containing "checkout", "dibeli" or "pembayaran" is false for one.
 * The gate found a free-community creator being told their numbers would appear
 * "setelah pembayaran pertama berhasil" — a payment that can never happen.
 */
export const REQUEST_ACCESS_MODE = "request";

/** True when this community's members join by asking rather than by paying. */
export function isRequestMode(community: { accessMode: string }): boolean {
  return community.accessMode === REQUEST_ACCESS_MODE;
}

/**
 * The label above a community's public link. It is a CHECKOUT link only for a
 * paid community; for a free one it opens a join-request form and calling it a
 * checkout misdescribes the single most-shared thing in the product.
 */
export function publicLinkLabel(community: { accessMode: string }): string {
  return isRequestMode(community)
    ? "Tautan pendaftaran publik — sebarkan ini ke calon anggota"
    : "Tautan checkout publik — sebarkan ini ke calon anggota";
}

/**
 * `community.access_mode` — how a member gets IN, which is a different question
 * from `status` (whether the page is open at all).
 *
 * Only the two values `updateCommunitySchema`'s `z.enum(["paid", "request"])`
 * accepts are named; anything else falls through to the raw string rather than
 * being quietly relabelled, the same way `communityStatusLabel` handles a value
 * this dashboard does not know.
 */
export function accessModeLabel(accessMode: string): string {
  switch (accessMode) {
    case "paid":
      return "Berbayar — anggota membayar untuk bergabung";
    case "request":
      return "Gratis — anggota mengajukan permintaan, Anda menyetujui";
    default:
      return accessMode;
  }
}

/**
 * WHAT THE MODE ACTUALLY DOES, the same job `communityStatusExplanation` does
 * for `status`, and for the same reason: "Gratis" alone does not tell a creator
 * that switching turns their prices off and puts every new member behind their
 * own approval, nor that the public page stops offering a purchase entirely
 * (`RequestToJoin` 404s a `paid` community's join route and `StartCheckout` is
 * never reached for a `request` one — apps/api).
 */
export function accessModeExplanation(accessMode: string): string {
  switch (accessMode) {
    case "paid":
      return (
        "Halaman publik menampilkan harga dan anggota membayar lewat Xendit untuk bergabung. " +
        "Harga paket Anda berlaku."
      );
    case "request":
      return (
        "Halaman publik tidak menampilkan harga. Calon anggota mengisi nama dan nomor WhatsApp, " +
        "lalu menunggu Anda menyetujui atau menolak di tab \u201cAnggota\u201d. Tidak ada pembayaran " +
        "sama sekali, dan paket berbayar Anda tidak bisa dibeli selama mode ini aktif."
      );
    default:
      return `Cara bergabung "${accessMode}" tidak dikenali oleh dasbor ini.`;
  }
}

/**
 * WHAT THE STATUS ACTUALLY DOES, not just its name.
 *
 * `paused` is the one a creator cannot guess: the checkout page still RENDERS, so
 * every link already broadcast into WhatsApp keeps working, but `StartCheckout`
 * answers 409 for any purchase. Saying only "Dijeda" would leave a creator
 * believing either that the link is dead or that sales continue, and both are
 * wrong. See `VISIBLE_STATUSES` in apps/api/src/application/use-cases/get-public-community.ts.
 */
export function communityStatusExplanation(status: string, accessMode = "paid"): string {
  // A request-mode community has no checkout page, no purchase and no
  // "pembelian baru ditolak" — all three sentences below are false for one, and
  // the `active` one is on screen twice (the community card and the overview)
  // for every free community. `accessMode` defaults to "paid" so the many
  // callers that predate it are unchanged.
  const free = accessMode === REQUEST_ACCESS_MODE;
  switch (status) {
    case "active":
      return free
        ? "Halaman pendaftaran terbuka dan calon anggota bisa mengajukan permintaan."
        : "Halaman checkout terbuka dan paket Anda bisa dibeli.";
    case "paused":
      return free
        ? "Halaman pendaftaran tetap terbuka — setiap tautan yang sudah Anda sebarkan masih hidup — " +
            "tetapi permintaan baru ditolak. Anggota yang sudah ada tidak terpengaruh."
        : "Halaman checkout tetap terbuka — setiap tautan yang sudah Anda sebarkan masih hidup — " +
            "tetapi pembelian baru ditolak. Anggota yang sudah ada tidak terpengaruh.";
    case "archived":
      return free
        ? "Halaman pendaftaran tidak dapat dibuka lagi (404 bagi pengunjung). Anggota yang sudah " +
            "ada tidak dikeluarkan."
        : "Halaman checkout tidak dapat dibuka lagi (404 bagi pengunjung). Anggota yang sudah ada " +
            "tidak dikeluarkan, dan pengingat perpanjangan tidak dikirim.";
    default:
      return `Status "${status}" tidak dikenali oleh dasbor ini.`;
  }
}

export function memberStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Aktif";
    case "past_due":
      return "Lewat jatuh tempo";
    case "churned":
      return "Berhenti";
    default:
      return status;
  }
}

/**
 * The three member statuses, explained.
 *
 * `past_due` IS THE NON-OBVIOUS ONE and the reason this function exists: a
 * past-due member is inside their grace period and STILL HAS GROUP ACCESS. A
 * creator who reads "lewat jatuh tempo" as "locked out" will go and remove them by
 * hand, which is precisely the mistake the grace period exists to avoid.
 */
export function memberStatusExplanation(status: string): string {
  switch (status) {
    case "active":
      return "Pembayaran lancar dan akses grup aktif.";
    case "past_due":
      return "Belum membayar perpanjangan, tetapi MASIH punya akses grup selama masa tenggang.";
    case "churned":
      return "Masa tenggang berakhir tanpa pembayaran. Akses grup sudah dicabut.";
    default:
      return "";
  }
}

export function liveSessionStatusLabel(status: string): string {
  switch (status) {
    case "scheduled":
      return "Terjadwal";
    case "live":
      return "Live";
    case "ended":
      return "Selesai";
    default:
      return status;
  }
}

/**
 * WHAT THE STATUS ACTUALLY MEANS FOR OBS, not just its name — same reasoning
 * as `communityStatusExplanation`. `ended` is the one a creator could
 * otherwise misread as "just not started yet, try starting OBS again": see
 * `AuthoriseStream`'s `PUBLISHABLE_STATUSES` (apps/api) — the stream key
 * stops authorising a NEW publish the moment the session ends, on purpose,
 * so nobody who captured the RTMP URL can restart it after the creator moved
 * on.
 */
export function liveSessionStatusExplanation(status: string): string {
  switch (status) {
    case "scheduled":
      return "Belum dimulai. Masukkan URL RTMP dan stream key di bawah ke OBS, lalu tekan “Start Streaming”.";
    case "live":
      return "Sedang berlangsung — OBS Anda saat ini mengirim video ke server.";
    case "ended":
      return "Sudah selesai. Stream key ini tidak bisa dipakai untuk memulai siaran baru.";
    default:
      return "";
  }
}

const DATE_TIME = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const DATE_ONLY = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** An ISO instant as a local date and time. Returns the raw value if unparseable. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME.format(date);
}

/**
 * A calendar date (`YYYY-MM-DD` or an ISO instant) as a date.
 *
 * `YYYY-MM-DD` is parsed as UTC midnight by `new Date`, which in a UTC-negative
 * timezone would render the day BEFORE the billing date. Split and constructed
 * explicitly so a next-billing-date is never off by one for a reader.
 */
export function formatDate(value: string): string {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (plain !== null) {
    const date = new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
    return DATE_ONLY.format(date);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DATE_ONLY.format(date);
}

/** The link a creator broadcasts. Absolute, because they paste it into WhatsApp. */
export function publicCheckoutUrl(slug: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/c/${slug}`;
}
