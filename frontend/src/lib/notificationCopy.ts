import type { ApiNotification } from "./api";
import { formatRupiah } from "./format";

/**
 * Every sentence the bell can say, in one place.
 *
 * The API returns `type` + `data` and nothing human-readable: UI copy is the
 * frontend's job (CLAUDE.md), and so is deciding where a notification leads,
 * because routes are a frontend concept. Adding an event type means adding one
 * case here and nowhere else.
 */
export type NotificationCopy = {
  text: string;
  /** Where clicking goes. `null` means the row is not a link — see message.sent. */
  link: string | null;
};

const str = (data: Record<string, unknown>, key: string): string =>
  typeof data[key] === "string" ? (data[key] as string) : "";

/** Post detail routes are per type; the others have no page of their own. */
function postLink(communityId: string | null, postType: string, postId: string | null): string | null {
  if (!communityId || !postId) return null;
  const segment = { diskusi: "discussion", event: "event", pengumuman: "announcement" }[postType];
  return segment ? `/community/${communityId}/${segment}/${postId}` : `/community/${communityId}`;
}

export function notificationCopy(n: ApiNotification): NotificationCopy {
  const d = n.data;

  switch (n.type) {
    case "post.commented":
      return {
        text: `${str(d, "actorName")} membalas “${str(d, "postTitle")}”`,
        link: postLink(n.communityId, str(d, "postType"), n.entityId),
      };

    case "payment.confirmed":
      return {
        // Cents arrive from the API; formatting belongs here (lib/format.ts).
        text: `Pembayaran ${formatRupiah(Number(d.amountCents ?? 0))} untuk ${str(d, "tierName")} di ${str(d, "communityName")} berhasil`,
        link: n.communityId ? `/community/${n.communityId}` : null,
      };

    case "member.joined":
      return {
        text: `${str(d, "actorName")} bergabung ke ${str(d, "communityName")} lewat tier ${str(d, "tierName")}`,
        link: n.communityId ? `/community/${n.communityId}?tab=Anggota` : null,
      };

    case "membership.ended":
      return {
        text: `Keanggotaanmu di ${str(d, "communityName")} sudah berakhir`,
        link: "/discover",
      };

    case "message.sent":
      return {
        text: `Pesan baru dari ${str(d, "actorName")}: ${str(d, "preview")}`,
        // Direct messages live in the floating chat widget, which has no route of
        // its own — so this row says what happened without pretending to lead
        // somewhere. Wiring it to open the widget is a follow-up, not a fake link.
        link: null,
      };

    default:
      // An event type the server knows and this build does not. Better a plain
      // line than a blank row.
      return { text: "Ada aktivitas baru di akunmu", link: null };
  }
}

/** "3 menit lalu" — same idiom the feed uses, kept local to the bell. */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "baru saja";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} hari lalu`;
  return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}
