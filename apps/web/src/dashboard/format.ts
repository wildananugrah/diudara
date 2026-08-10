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
 * WHAT THE STATUS ACTUALLY DOES, not just its name.
 *
 * `paused` is the one a creator cannot guess: the checkout page still RENDERS, so
 * every link already broadcast into WhatsApp keeps working, but `StartCheckout`
 * answers 409 for any purchase. Saying only "Dijeda" would leave a creator
 * believing either that the link is dead or that sales continue, and both are
 * wrong. See `VISIBLE_STATUSES` in apps/api/src/application/use-cases/get-public-community.ts.
 */
export function communityStatusExplanation(status: string): string {
  switch (status) {
    case "active":
      return "Halaman checkout terbuka dan paket Anda bisa dibeli.";
    case "paused":
      return (
        "Halaman checkout tetap terbuka — setiap tautan yang sudah Anda sebarkan masih hidup — " +
        "tetapi pembelian baru ditolak. Anggota yang sudah ada tidak terpengaruh."
      );
    case "archived":
      return (
        "Halaman checkout tidak dapat dibuka lagi (404 bagi pengunjung). Anggota yang sudah ada " +
        "tidak dikeluarkan, dan pengingat perpanjangan tidak dikirim."
      );
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
