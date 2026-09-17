/**
 * Seeds the content the SPA's original mock fixture carried, so the app looks
 * identical to the mockup on first run — same community ids, same Indonesian
 * copy — but every byte now comes from Postgres. That fixture
 * (frontend/src/data/mock.ts) has since been deleted; this file is the
 * canonical source of the demo data.
 *
 * Idempotent: truncates the app tables first, so re-running gives a clean state.
 */
import { mkdir } from "node:fs/promises";
import { db, queryClient } from "./client.ts";
import { newPublishSecret, newStreamKey, streamPathFor } from "../../domain/streamPath.ts";
import {
  commentLikes, comments, communities, communityMembers, conversationParticipants,
  conversations, documentDownloads, documents, liveChatMessages, liveSessions,
  messageAttachments, messages, payments, postAttachments, posts, subscriptions,
  syllabi, syllabusItems, tiers, trendingTags, uploads, users,
} from "./schema.ts";

const hash = await Bun.password.hash("password123", { algorithm: "argon2id" });

// Must match backend/.env's STORAGE_DIR — seeded documents write real files here.
const STORAGE_DIR = process.env.STORAGE_DIR ?? "./storage";
await mkdir(STORAGE_DIR, { recursive: true });

const PEOPLE = [
  { key: "rangga", name: "Rangga Putra", email: "rangga@diudara.id", color: "#93A8C2" },
  { key: "andi", name: "Pak Andi (Mentor)", email: "andi@diudara.id", color: "var(--langit)" },
  { key: "sari", name: "Sari Wulandari", email: "sari@diudara.id", color: "var(--sinyal)" },
  { key: "budi", name: "Budi Prakoso", email: "budi@diudara.id", color: "var(--hijau-lepas)" },
  { key: "dewi", name: "Dewi Anggraini", email: "dewi@diudara.id", color: "var(--langit-light)" },
  { key: "fajar", name: "Fajar Nugroho", email: "fajar@diudara.id", color: "var(--kabut)" },
  { key: "rina", name: "Rina Kusuma", email: "rina@diudara.id", color: "var(--merah-senja)" },
  { key: "dimas", name: "Dimas Ardianto", email: "dimas@diudara.id", color: "var(--hijau-lepas)" },
  { key: "melati", name: "Melati Anggraini", email: "melati@diudara.id", color: "var(--kabut)" },
  { key: "anwar", name: "Anwar Hidayat", email: "anwar@diudara.id", color: "var(--langit)" },
  { key: "lisa", name: "Lisa Permata", email: "lisa@diudara.id", color: "var(--sinyal)" },
  { key: "yoga", name: "Yoga Saputra", email: "yoga@diudara.id", color: "var(--hijau-lepas)" },
  { key: "nadia", name: "Nadia Ramadhani", email: "nadia@diudara.id", color: "var(--merah-senja)" },
] as const;

const initialsOf = (name: string) => {
  const parts = name.replace(/\(.*\)/, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
};

const COMMUNITIES = [
  { id: "bimbel-sbmptn", name: "Bimbel Matematika Pak Andi", niche: "Edukasi", category: "Bimbel & Ujian", priceCents: 14900000, billingPeriod: "/ bulan", color: "var(--langit)", owner: "andi", description: "Kelas persiapan SBMPTN dengan diskusi soal harian dan sesi tanya-jawab langsung." },
  { id: "coaching-bisnis", name: "Scale Up Business Circle", niche: "Bisnis", category: "Coaching Bisnis", priceCents: 29900000, billingPeriod: "/ bulan", color: "var(--hijau-lepas)", owner: "budi", description: "Komunitas founder dan pelaku UMKM untuk saling berbagi strategi pertumbuhan." },
  { id: "kajian-online", name: "Kajian Rutin Ba'da Maghrib", niche: "Kajian", category: "Kajian & Rohani", priceCents: 0, billingPeriod: "", color: "var(--sinyal)", owner: "dewi", description: "Kajian rutin online setiap hari, terbuka untuk umum dengan donasi sukarela." },
  { id: "finansial-cerdas", name: "Kelas Finansial Cerdas", niche: "Finansial", category: "Edukasi Finansial", priceCents: 19900000, billingPeriod: "/ bulan", color: "var(--merah-senja)", owner: "rangga", description: "Belajar mengatur keuangan pribadi, investasi dasar, dan bebas utang bersama mentor." },
  { id: "desain-ui", name: "UI/UX Practice ID", niche: "Desain", category: "Skill Digital", priceCents: 9900000, billingPeriod: "/ bulan", color: "var(--kabut)", owner: "melati", description: "Latihan case study UI/UX mingguan dengan review langsung dari mentor." },
  { id: "content-creator", name: "Content Creator Hub", niche: "Konten", category: "Kreator & Media", priceCents: 12900000, billingPeriod: "/ bulan", color: "var(--langit-light)", owner: "dimas", description: "Tempat berbagi strategi konten, kolaborasi, dan review video sesama kreator." },
] as const;

const TIERS = [
  { name: "Basic", priceCents: 7900000, highlight: false, benefits: ["Akses grup diskusi", "Materi dasar", "Notifikasi event"] },
  { name: "Pro", priceCents: 14900000, highlight: true, benefits: ["Semua benefit Basic", "Sesi live mingguan", "Akses modul lengkap", "Prioritas tanya-jawab"] },
  { name: "VIP", priceCents: 34900000, highlight: false, benefits: ["Semua benefit Pro", "1-on-1 konsultasi bulanan", "Review tugas personal", "Sertifikat penyelesaian"] },
] as const;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000);

console.log("[seed] clearing existing data…");
// Child-first so foreign keys never block the delete.
for (const t of [
  commentLikes, comments, postAttachments, posts, messageAttachments, messages,
  conversationParticipants, conversations, liveChatMessages, liveSessions,
  documentDownloads, documents, syllabusItems, syllabi, payments, subscriptions,
  communityMembers, tiers, communities, uploads, users, trendingTags,
]) {
  await db.delete(t);
}

console.log("[seed] users…");
const userRows = await db.insert(users).values(
  PEOPLE.map((p) => ({
    email: p.email, passwordHash: hash, name: p.name,
    handle: `@${p.key}`, avatarColor: p.color, initials: initialsOf(p.name),
  })),
).returning();
const uid = (key: string) => {
  const person = PEOPLE.find((p) => p.key === key)!;
  return userRows.find((u) => u.email === person.email)!.id;
};

console.log("[seed] communities + tiers…");
await db.insert(communities).values(
  COMMUNITIES.map((c) => ({
    id: c.id, name: c.name, niche: c.niche, category: c.category,
    description: c.description, color: c.color,
    priceCents: c.priceCents, billingPeriod: c.billingPeriod, ownerId: uid(c.owner),
  })),
);

const tierRows = await db.insert(tiers).values(
  COMMUNITIES.flatMap((c) =>
    TIERS.map((t, i) => ({
      communityId: c.id, name: t.name, priceCents: t.priceCents,
      billingPeriod: "/ bulan", benefits: [...t.benefits], highlight: t.highlight, sortOrder: i,
    })),
  ),
).returning();
const tierOf = (communityId: string, name: string) =>
  tierRows.find((t) => t.communityId === communityId && t.name === name)!.id;

console.log("[seed] memberships…");
// Owners first, then the member roster from mock.ts's `members` array.
const memberships: Array<typeof communityMembers.$inferInsert> = COMMUNITIES.map((c) => ({
  communityId: c.id, userId: uid(c.owner), role: "owner" as const,
  status: "active" as const, tierId: tierOf(c.id, "VIP"), joinedAt: daysAgo(240),
}));

// mock.ts: myJoinedCommunityIds for the current user, and myCreatedCommunityIds
// (rangga owns finansial-cerdas above; admin on bimbel-sbmptn here).
memberships.push(
  { communityId: "bimbel-sbmptn", userId: uid("rangga"), role: "admin", status: "active", tierId: tierOf("bimbel-sbmptn", "Pro"), joinedAt: daysAgo(120) },
  { communityId: "kajian-online", userId: uid("rangga"), role: "member", status: "active", tierId: tierOf("kajian-online", "Basic"), joinedAt: daysAgo(90) },
  { communityId: "desain-ui", userId: uid("rangga"), role: "member", status: "active", tierId: tierOf("desain-ui", "Basic"), joinedAt: daysAgo(60) },
  // The `members` roster shown on the Anggota tab.
  { communityId: "bimbel-sbmptn", userId: uid("sari"), role: "member", status: "active", tierId: tierOf("bimbel-sbmptn", "Pro"), joinedAt: daysAgo(90) },
  { communityId: "bimbel-sbmptn", userId: uid("budi"), role: "member", status: "active", tierId: tierOf("bimbel-sbmptn", "Pro"), joinedAt: daysAgo(60) },
  { communityId: "bimbel-sbmptn", userId: uid("dewi"), role: "admin", status: "active", tierId: tierOf("bimbel-sbmptn", "VIP"), joinedAt: daysAgo(240) },
  { communityId: "bimbel-sbmptn", userId: uid("fajar"), role: "member", status: "pending", tierId: tierOf("bimbel-sbmptn", "Basic"), joinedAt: hoursAgo(5) },
  { communityId: "bimbel-sbmptn", userId: uid("rina"), role: "member", status: "churned", tierId: tierOf("bimbel-sbmptn", "Basic"), joinedAt: daysAgo(150), endedAt: daysAgo(3) },
  { communityId: "bimbel-sbmptn", userId: uid("dimas"), role: "member", status: "active", tierId: tierOf("bimbel-sbmptn", "Basic"), joinedAt: daysAgo(45) },
  { communityId: "bimbel-sbmptn", userId: uid("melati"), role: "member", status: "active", tierId: tierOf("bimbel-sbmptn", "Pro"), joinedAt: daysAgo(30) },
  // finansial-cerdas roster, for the second creator dashboard.
  { communityId: "finansial-cerdas", userId: uid("anwar"), role: "member", status: "pending", tierId: tierOf("finansial-cerdas", "Basic"), joinedAt: hoursAgo(1) },
  { communityId: "finansial-cerdas", userId: uid("lisa"), role: "member", status: "active", tierId: tierOf("finansial-cerdas", "VIP"), joinedAt: daysAgo(30) },
  { communityId: "finansial-cerdas", userId: uid("yoga"), role: "member", status: "active", tierId: tierOf("finansial-cerdas", "Pro"), joinedAt: daysAgo(120) },
  { communityId: "finansial-cerdas", userId: uid("nadia"), role: "member", status: "churned", tierId: tierOf("finansial-cerdas", "Basic"), joinedAt: daysAgo(200), endedAt: daysAgo(1) },
  { communityId: "finansial-cerdas", userId: uid("sari"), role: "member", status: "active", tierId: tierOf("finansial-cerdas", "Basic"), joinedAt: daysAgo(15) },
);
await db.insert(communityMembers).values(memberships);

console.log("[seed] posts…");
const B = "bimbel-sbmptn";
const postRows = await db.insert(posts).values([
  // forumPosts -> diskusi
  { communityId: B, authorId: uid("sari"), type: "diskusi", tag: "Diskusi", topic: "Trigonometri", title: "Ada yang mau bahas soal integral trigonometri?", body: "Aku masih bingung di bagian substitusi, ada yang bisa bantu jelasin dengan contoh soal?", createdAt: hoursAgo(2) },
  { communityId: B, authorId: uid("budi"), type: "diskusi", tag: "Sharing", topic: "Strategi Belajar", title: "Rekomendasi jadwal belajar 3 bulan menjelang ujian", body: "Mau share jadwal belajar yang aku pakai, semoga bisa membantu teman-teman yang lain juga.", createdAt: hoursAgo(5) },
  { communityId: B, authorId: uid("andi"), type: "pengumuman", tag: "Pengumuman", title: "Pengumuman: sesi live tambahan Sabtu ini", body: "Karena banyak yang minta, kita adakan sesi live tambahan jam 19.00 WIB membahas soal try out kemarin.", createdAt: daysAgo(1) },
  // announcements
  { communityId: B, authorId: uid("andi"), type: "pengumuman", tag: "Pengumuman", title: "Perubahan jadwal live mingguan", body: "Mulai minggu depan, sesi live Q&A dipindah dari hari Sabtu ke hari Jumat pukul 19.00 WIB. Mohon disesuaikan ya!", createdAt: hoursAgo(2) },
  { communityId: B, authorId: uid("dewi"), type: "pengumuman", tag: "Pengumuman", title: "Peraturan komunitas — wajib dibaca member baru", body: "Dilarang membagikan link grup ke pihak luar, saling menghormati sesama member, dan gunakan bahasa yang sopan di forum diskusi.", createdAt: daysAgo(1) },
  { communityId: B, authorId: uid("andi"), type: "pengumuman", tag: "Pengumuman", title: "Selamat! Try out 2 sudah bisa diakses", body: "Hasil dan pembahasan try out 2 sudah tersedia di tab Dokumen. Jangan lupa dicek dan pelajari kesalahan masing-masing.", createdAt: daysAgo(4) },
  { communityId: B, authorId: uid("dewi"), type: "pengumuman", tag: "Pengumuman", title: "Libur sesi live — long weekend", body: "Tidak ada sesi live minggu ini karena long weekend. Sesi live berikutnya kembali normal minggu depan.", createdAt: daysAgo(7) },
  // konten
  { communityId: B, authorId: uid("andi"), type: "konten", tag: "Materi", syllabus: "Minggu 3 — Kalkulus Dasar", title: "Materi baru: Minggu 3 — Kalkulus Dasar", body: "Modul kalkulus dasar sudah tersedia, berisi materi limit, turunan, dan latihan soal integral.", createdAt: daysAgo(1) },
  // calendarSchedule -> event
  { communityId: B, authorId: uid("andi"), type: "event", tag: "Kegiatan", title: "Live Q&A — Fungsi Kuadrat", body: "Sesi tanya-jawab langsung membahas soal-soal fungsi kuadrat yang sering keluar di try out. Bawa pertanyaanmu, langsung dijawab Pak Andi.", eventDate: "10 Sep", eventTime: "19:00 WIB", eventLocation: "Online via Zoom", hasLiveRoom: true, createdAt: daysAgo(6) },
  { communityId: B, authorId: uid("andi"), type: "event", tag: "Kegiatan", title: "Live Q&A — Persiapan Try Out 3", body: "Pembahasan strategi mengerjakan try out 3 beserta tips manajemen waktu saat ujian. Sesi ini direkam dan bisa ditonton ulang di tab Dokumen.", eventDate: "12 Sep", eventTime: "19:00 WIB", eventLocation: "Online via Zoom", hasLiveRoom: true, createdAt: daysAgo(5) },
  { communityId: B, authorId: uid("andi"), type: "event", tag: "Kegiatan", title: "Kelas tambahan: Trigonometri lanjutan", body: "Kelas tatap muka daring khusus untuk member yang masih kesulitan di materi trigonometri lanjutan. Kuota terbatas, isi lewat form pendaftaran.", eventDate: "15 Sep", eventTime: "16:00 WIB", eventLocation: "Online via Zoom", hasLiveRoom: true, createdAt: daysAgo(4) },
  { communityId: B, authorId: uid("andi"), type: "event", tag: "Kegiatan", title: "Sesi motivasi bersama alumni", body: "Sharing santai bersama alumni yang lolos SBMPTN tahun lalu — cerita perjuangan, tips belajar efektif, dan sesi tanya-jawab bebas.", eventDate: "20 Sep", eventTime: "20:00 WIB", eventLocation: "Online via Zoom", hasLiveRoom: false, createdAt: daysAgo(3) },
]).returning();

console.log("[seed] comments…");
const diskusi1 = postRows[0]!.id;
const diskusi2 = postRows[1]!.id;
const announce1 = postRows[2]!.id;
const commentRows = await db.insert(comments).values([
  { postId: diskusi1, authorId: uid("andi"), body: "Coba mulai dari substitusi u = sin x atau u = cos x tergantung bentuk soalnya. Nanti aku bahas lebih detail di sesi live Sabtu ya.", createdAt: hoursAgo(1) },
  { postId: diskusi1, authorId: uid("dimas"), body: "Setuju, kemarin aku juga sempet kebingungan di soal yang sama. Contoh soal try out nomor 12 bisa jadi latihan bagus.", createdAt: hoursAgo(1) },
  { postId: diskusi1, authorId: uid("sari"), body: "Makasih Pak Andi, ditunggu sesi Sabtunya!", createdAt: hoursAgo(1) },
  { postId: diskusi2, authorId: uid("melati"), body: "Boleh nih dicoba, aku juga lagi cari format jadwal yang pas buat 3 bulan terakhir.", createdAt: hoursAgo(4) },
  { postId: diskusi2, authorId: uid("rangga"), body: "Share juga dong link templatenya kalau ada, Budi.", createdAt: hoursAgo(3) },
  { postId: announce1, authorId: uid("dimas"), body: "Mantap, aku daftar. Jam 19.00 WIB ya Pak?", createdAt: hoursAgo(20) },
  { postId: announce1, authorId: uid("andi"), body: "Betul, jam 19.00 WIB di ruang live yang sama seperti biasa.", createdAt: hoursAgo(18) },
]).returning();

// Likes exist in the mock as counts; here they are real rows so the number is derived.
await db.insert(commentLikes).values(
  [uid("sari"), uid("budi"), uid("dimas"), uid("melati")].map((userId) => ({ commentId: commentRows[0]!.id, userId })),
);

console.log("[seed] materi (syllabi)…");
const syllabusRows = await db.insert(syllabi).values([
  { id: "week-1", communityId: B, title: "Minggu 1 — Dasar Aljabar", sortOrder: 0 },
  { id: "week-2", communityId: B, title: "Minggu 2 — Trigonometri", sortOrder: 1 },
  { id: "week-3", communityId: B, title: "Minggu 3 — Kalkulus Dasar", sortOrder: 2 },
]).returning();
void syllabusRows;

await db.insert(syllabusItems).values([
  { syllabusId: "week-1", title: "Pengenalan fungsi kuadrat", type: "video", duration: "18:20", sortOrder: 0 },
  { syllabusId: "week-1", title: "Latihan soal aljabar dasar", type: "ebook", duration: "12 hal", sortOrder: 1 },
  { syllabusId: "week-1", title: "Kuis mingguan", type: "quiz", duration: "10 soal", sortOrder: 2 },
  { syllabusId: "week-2", title: "Identitas trigonometri", type: "video", duration: "24:10", sortOrder: 0 },
  { syllabusId: "week-2", title: "Rekaman audio ringkasan", type: "audio", duration: "9:45", sortOrder: 1 },
  { syllabusId: "week-3", title: "Limit dan turunan", type: "video", duration: "31:02", sortOrder: 0 },
  { syllabusId: "week-3", title: "Modul latihan integral", type: "ebook", duration: "20 hal", sortOrder: 1 },
]);

console.log("[seed] documents…");
/**
 * Each seeded document gets a REAL file on disk and a real `uploads` row.
 * documents.upload_id is joined when serving a download, so rows without one
 * 404 on every download attempt — the Dokumen tab would look populated and be
 * entirely non-functional.
 *
 * The bytes are placeholder text, not genuine PDFs/MP4s; sizeBytes still
 * reports the figure the mockup displayed so the UI reads as intended.
 */
const MIME_BY_TYPE: Record<string, string> = {
  document: "application/pdf",
  video: "video/mp4",
  file: "application/octet-stream",
};

async function seedUploadFor(name: string, type: string, ownerId: string) {
  const storageKey = `seed-${crypto.randomUUID()}`;
  await Bun.write(
    `${STORAGE_DIR}/${storageKey}`,
    `DIUDARA seed placeholder for "${name}".\nThis is not real ${type} content.\n`,
  );
  const [row] = await db.insert(uploads).values({
    uploaderId: ownerId, filename: name, mime: MIME_BY_TYPE[type] ?? "application/octet-stream",
    sizeBytes: 0, storageKey, kind: type === "video" ? "video" : "file",
  }).returning();
  return row!.id;
}

const docSpecs: Array<{ communityId: string; name: string; type: string; sizeBytes: number; createdAt: Date }> = [
  { communityId: B, name: "Rangkuman Trigonometri.pdf", type: "document", sizeBytes: 2_400_000, createdAt: daysAgo(3) },
  { communityId: B, name: "Rekaman Live — Sesi Q&A 4.mp4", type: "video", sizeBytes: 340_000_000, createdAt: daysAgo(5) },
  { communityId: B, name: "Template Latihan Soal SBMPTN.docx", type: "file", sizeBytes: 180_000, createdAt: daysAgo(7) },
  { communityId: B, name: "Pembahasan Try Out 2.pdf", type: "document", sizeBytes: 3_100_000, createdAt: daysAgo(7) },
  { communityId: B, name: "Rekaman Kelas Tambahan Trigonometri.mp4", type: "video", sizeBytes: 512_000_000, createdAt: daysAgo(14) },
  { communityId: B, name: "Bank Soal Kalkulus Dasar.pdf", type: "document", sizeBytes: 1_800_000, createdAt: daysAgo(21) },
  { communityId: "finansial-cerdas", name: "Template Anggaran Bulanan.xlsx", type: "file", sizeBytes: 220_000, createdAt: daysAgo(10) },
  { communityId: "finansial-cerdas", name: "E-book Bebas Utang dalam 6 Bulan.pdf", type: "document", sizeBytes: 4_200_000, createdAt: daysAgo(20) },
  { communityId: "finansial-cerdas", name: "Rekaman Webinar Investasi Dasar.mp4", type: "video", sizeBytes: 480_000_000, createdAt: daysAgo(25) },
];

const docRows = await db.insert(documents).values(
  await Promise.all(docSpecs.map(async (d) => ({
    ...d,
    uploadId: await seedUploadFor(d.name, d.type, uid(d.communityId === "finansial-cerdas" ? "rangga" : "andi")),
  }))),
).returning();

// Download events, so the dashboard's topDocuments ordering is derived rather
// than hardcoded. Counts mirror the mock's relative ranking.
const downloadPlan: Array<[string, number]> = [
  ["Rangkuman Trigonometri.pdf", 41], ["Bank Soal Kalkulus Dasar.pdf", 29],
  ["Rekaman Live — Sesi Q&A 4.mp4", 18], ["Pembahasan Try Out 2.pdf", 9],
  ["Template Anggaran Bulanan.xlsx", 35], ["E-book Bebas Utang dalam 6 Bulan.pdf", 24],
  ["Rekaman Webinar Investasi Dasar.mp4", 16],
];
const downloaders = [uid("sari"), uid("budi"), uid("dimas"), uid("melati"), uid("rangga")];
await db.insert(documentDownloads).values(
  downloadPlan.flatMap(([name, n]) => {
    const doc = docRows.find((d) => d.name === name)!;
    return Array.from({ length: n }, (_, i) => ({
      documentId: doc.id, userId: downloaders[i % downloaders.length]!, createdAt: daysAgo(i % 30),
    }));
  }),
);

console.log("[seed] subscriptions + payments…");
// Six months of paid history so revenueByMonth has a real shape, plus a few
// failures so successRate is a real ratio rather than a constant.
const payingMembers = memberships.filter((m) => m.status === "active" && m.role === "member");
const subRows = await db.insert(subscriptions).values(
  payingMembers.map((m) => ({
    communityId: m.communityId, userId: m.userId, tierId: m.tierId!,
    status: "active" as const, startedAt: m.joinedAt, endsAt: daysAgo(-30),
  })),
).returning();

const paymentValues: Array<typeof payments.$inferInsert> = [];
for (const sub of subRows) {
  const tier = tierRows.find((t) => t.id === sub.tierId)!;
  for (let monthsBack = 5; monthsBack >= 0; monthsBack--) {
    const paidAt = new Date();
    paidAt.setMonth(paidAt.getMonth() - monthsBack);
    if (tier.priceCents === 0) continue;
    paymentValues.push({
      subscriptionId: sub.id, amountCents: tier.priceCents, method: "qris",
      status: "paid", gatewayRef: `seed_${sub.id}_${monthsBack}`, paidAt, createdAt: paidAt,
    });
  }
}
// Failed attempts — the only source successRate can be computed from.
for (const sub of subRows.slice(0, 2)) {
  const tier = tierRows.find((t) => t.id === sub.tierId)!;
  paymentValues.push({
    subscriptionId: sub.id, amountCents: tier.priceCents, method: "va",
    status: "failed", gatewayRef: `seed_failed_${sub.id}`, createdAt: hoursAgo(3),
  });
}
await db.insert(payments).values(paymentValues);

console.log("[seed] conversations…");
const rangga = uid("rangga");
const chatPlan: Array<{ peer: string; messages: Array<{ from: "me" | "them"; text: string; hoursAgo: number }> }> = [
  { peer: "sari", messages: [
    { from: "them", text: "Kak, izin nanya soal integral trigonometri kemarin", hoursAgo: 6 },
    { from: "me", text: "Boleh, bagian mana yang masih bingung?", hoursAgo: 5.9 },
    { from: "them", text: "Bagian substitusinya kak", hoursAgo: 5.8 },
    { from: "me", text: "Coba mulai dari u = sin x dulu, nanti tak kirimin contoh soalnya", hoursAgo: 5.7 },
    { from: "them", text: "Makasih banyak infonya kak 🙏", hoursAgo: 0.05 },
  ] },
  { peer: "andi", messages: [
    { from: "me", text: "Pak, sesi live tambahan Sabtu ini jadi jam berapa ya?", hoursAgo: 2 },
    { from: "them", text: "Jam 19.00 WIB seperti biasa", hoursAgo: 1.2 },
    { from: "them", text: "Oke, nanti aku bahas di sesi live ya", hoursAgo: 1 },
  ] },
  { peer: "dimas", messages: [
    { from: "them", text: "Kelas tambahan trigonometri jadi ikut kan?", hoursAgo: 4 },
    { from: "me", text: "Jadi dong, aku daftar tadi malam", hoursAgo: 3.5 },
    { from: "them", text: "Siap, sampai ketemu di kelas tambahan", hoursAgo: 3 },
  ] },
  { peer: "melati", messages: [
    { from: "them", text: "Kak, jadwal belajar yang kamu share di forum keren banget", hoursAgo: 26 },
    { from: "me", text: "Makasih! Itu aku pakai dari awal semester", hoursAgo: 25 },
    { from: "them", text: "Boleh dong, share link templatenya", hoursAgo: 24 },
  ] },
];

for (const plan of chatPlan) {
  const [conv] = await db.insert(conversations).values({}).returning();
  const peerId = uid(plan.peer);
  await db.insert(conversationParticipants).values([
    // Deliberately no lastReadAt for rangga on the first two threads, so the
    // unread badge the mockup shows is computed rather than hardcoded.
    { conversationId: conv!.id, userId: rangga, lastReadAt: plan.peer === "sari" || plan.peer === "melati" ? null : new Date() },
    { conversationId: conv!.id, userId: peerId, lastReadAt: new Date() },
  ]);
  await db.insert(messages).values(
    plan.messages.map((m) => ({
      conversationId: conv!.id,
      senderId: m.from === "me" ? rangga : peerId,
      body: m.text,
      createdAt: new Date(Date.now() - m.hoursAgo * 3600_000),
    })),
  );
}

console.log("[seed] live room + trending tags…");
// The room is PROVISIONED, not broadcasting. The mock showed bimbel-sbmptn as
// permanently live with 128 viewers and three chat messages from a session that
// never happened; all three were fiction that outlived the mock. A seeded room
// now looks exactly like a real one before its first stream: idle, with
// credentials ready, no audience, no history.
//
// The key is MINTED, not written literally — :1935 is public, so a key derived
// from the community slug (this row once carried "bimbel-sbmptn-live") is a
// broadcast path anyone who reads the url bar can guess. It is a PUBLIC path
// segment; the secret beside it is the actual broadcast credential, and the two
// rotate together. Printed so a dev can paste them into OBS without the UI.
const seededStreamKey = newStreamKey();
const seededPublishSecret = newPublishSecret();
await db.insert(liveSessions).values({
  communityId: B, title: "Live Q&A — Fungsi Kuadrat", status: "idle",
  streamKey: seededStreamKey, publishSecret: seededPublishSecret,
});
console.log(`[seed]   OBS server    : rtmp://<host>:1935/c`);
console.log(`[seed]   OBS stream key: ${seededStreamKey}?user=diudara&pass=${seededPublishSecret}`);
console.log(`[seed]   (path ${streamPathFor(seededStreamKey)}; the room goes live when OBS connects)`);

await db.insert(trendingTags).values(
  ["#SBMPTN2027", "#UMKM", "#InvestasiPemula", "#DesainUI", "#KontenKreator", "#ProduktivitasKerja"]
    .map((tag, i) => ({ tag, sortOrder: i })),
);

console.log(`[seed] done — ${userRows.length} users, ${COMMUNITIES.length} communities, ${postRows.length} posts, ${paymentValues.length} payments`);
console.log("[seed] login with any seeded email + password123 (e.g. rangga@diudara.id)");
await queryClient.end();
