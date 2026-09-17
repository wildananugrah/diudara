# DIUDARA — Frontend

React + Vite SPA for the DIUDARA paid community gateway. Talks to the Bun/Hono
API in `../backend`; there is no mock data layer any more.

## Menjalankan secara lokal

Butuh API dan database jalan lebih dulu:

```bash
cd ../infra   && docker compose up -d postgres
cd ../backend && bun install && bun run db:migrate && bun run db:seed && bun run dev
```

Lalu:

```bash
bun install
bun run dev
```

Buka `http://localhost:5173`. Vite mem-proxy `/api` ke `http://127.0.0.1:3004`,
jadi `VITE_API_URL` tidak perlu diisi saat development.

Login dengan akun hasil seed — email apa pun berakhiran `@diudara.id` dengan
password `password123`. Contoh: `rangga@diudara.id` (admin `bimbel-sbmptn`,
pemilik `finansial-cerdas`), `sari@diudara.id` (member biasa).

## Halaman

| Route | Halaman |
|---|---|
| `/login`, `/register` | Autentikasi |
| `/discover` | Jelajahi & cari komunitas |
| `/community/:id` | Komunitas — tab Feed, Materi, Anggota, Kegiatan, Pengumuman, Dokumen |
| `/community/:id/discussion/:postId` | Detail diskusi + komentar |
| `/community/:id/event/:eventId` | Detail kegiatan |
| `/community/:id/announcement/:id` | Detail pengumuman |
| `/live/:id` | Live Room |
| `/checkout/:id` | Pilih tier & metode pembayaran |
| `/creator/dashboard/:id` | Dashboard analytics creator (khusus admin) |
| `/onboarding` | Pulse-ID — AI co-builder setup komunitas |

Semua route selain `/login` dan `/register` butuh sesi.

## Struktur

```
src/
  lib/api.ts          client API bertipe + penyimpanan token
  lib/auth.tsx        AuthProvider, useAuth, RequireAuth
  lib/useApi.ts       hook fetch-on-mount
  lib/format.ts       format Rupiah, waktu relatif, ukuran file
  components/layout/  Sidebar, Header, AppShell, PageContainer
  components/feed/    FeedPostCard, PostEditorModal
  components/chat/    FloatingChat
  pages/              satu file per route
  styles/tokens.css   design tokens: palet Udara + tipografi
```

## Design tokens

Warna dan font didefinisikan sebagai CSS variables di `src/styles/tokens.css`
(palet "Udara — Langit & Sinyal", font Bricolage Grotesque + Plus Jakarta Sans).
Ubah di satu tempat ini untuk memengaruhi seluruh halaman.

## Catatan

Harga dikirim API dalam satuan **sen** (`priceCents`); pemformatan ke
"Rp149.000" dilakukan di `lib/format.ts`, bukan di server. Waktu dikirim sebagai
ISO string dan dirender dengan `timeAgo()`.

Live Room menampilkan tata letak video conference, tetapi pemutaran video belum
tersambung — lihat `SPEC.md` §6 untuk batasan cakupan yang lain.
