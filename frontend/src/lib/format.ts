/**
 * The API returns raw data (cents, ISO timestamps, integers). The mockup showed
 * preformatted Indonesian strings ("Rp149.000", "2 jam lalu", "1.240"), so the
 * formatting that used to be baked into mock.ts lives here instead.
 */

export function formatRupiah(cents: number): string {
  if (cents === 0) return "Gratis";
  return "Rp" + Math.round(cents / 100).toLocaleString("id-ID");
}

export function formatCount(n: number): string {
  return n.toLocaleString("id-ID");
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + " GB";
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + " MB";
  if (bytes >= 1_000) return Math.round(bytes / 1_000) + " KB";
  return bytes + " B";
}

/** "2 jam lalu", "3 hari lalu" — matches the mockup's relative-time copy. */
export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);

  if (seconds < 60) return "Baru saja";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} hari lalu`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} minggu lalu`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} bulan lalu`;
  return `${Math.floor(days / 365)} tahun lalu`;
}

/** Short form for chat list rows: "2m", "1j", "3h". */
export function timeAgoShort(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const then = typeof iso === "string" ? new Date(iso) : iso;
  const minutes = Math.floor((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "kini";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}j`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}h`;
  return `${Math.floor(days / 7)}mg`;
}

/** Clock time for chat bubbles: "10:02". */
export function clockTime(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

export function percent(value: number, digits = 1): string {
  return value.toFixed(digits).replace(".", ",") + "%";
}

export function initialsOf(name: string): string {
  const parts = name.replace(/\(.*\)/, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "??";
}
