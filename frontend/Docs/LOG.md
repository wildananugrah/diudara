# Log Perubahan

> Append-only. Entri baru selalu ditambahkan di PALING BAWAH file ini lewat
> `/end-session`. Jangan edit atau hapus entri lama.

## [2026-09-04 17:10] Setup awal — mockup dasar & workflow Docs

- Plan: -
- Status: selesai penuh
- Perubahan:
  - Setup project React + Vite + TypeScript
  - Buat 6 halaman inti: Discover, Community Home, Live Room, Checkout, Creator
    Dashboard, Pulse-ID Onboarding
  - Setup design tokens palet "Udara — Langit & Sinyal" + tipografi Bricolage
    Grotesque/Plus Jakarta Sans
  - Push ke GitHub (`adamfloothink/diudara`), deploy ke Vercel (`diudara.vercel.app`)
  - Setup workflow `Docs/` (SUMMARY, LOG, pending_works, completed_works) dan slash
    command `/start-session`, `/end-session` untuk Claude Code
- File terdampak: seluruh `src/`, `CLAUDE.md`, `.claude/commands/*`, `Docs/*`
- Catatan: ini baseline sebelum workflow Docs/ dipakai secara rutin. Sesi berikutnya
  seharusnya sudah mulai pakai `/start-session` dan `/end-session` secara konsisten.

## [2026-09-04 21:20] Design system global (sidebar, header, body) + fitur Community Home

- Plan: - (kerjaan ad-hoc, bukan dari pending_works — belum ada plan file dibuat)
- Status: selesai penuh
- Perubahan:
  - Bangun komponen layout global reusable: `Sidebar`, `Header`, `PageContainer`
    (`src/components/layout/`), dipakai di semua 6 halaman
  - Sidebar: collapsible, dropdown submenu untuk "Komunitas" (komunitas yang
    di-join) dan "Dashboard Creator" (komunitas yang dikelola), border + radius
    100% pada semua menu, logo Diudara + icon-only saat collapsed
  - Header: judul + breadcrumb opsional + notifikasi + avatar, slot `actions` untuk
    search/filter per halaman, divider inset/full-bleed tergantung ada-tidaknya
    sidebar
  - Ganti semua ikon emoji ke Font Awesome (emoji cuma tersisa di konten chat)
  - Community Home: tambah 3 tab baru (Kalender — termasuk grid kalender bulanan
    visual, Pengumuman — dengan badge "Baru", Dokumen/Library — daftar file);
    rename tab Content→Konten, Members→Anggota, Library→Dokumen; tab Konten jadi
    layout 2 kolom (menu materi + detail viewer video/audio/dokumen); banner
    komunitas jadi floating card dengan kontras teks otomatis
  - Creator Dashboard sekarang per-komunitas (route `/creator/dashboard/:id`,
    data di `creatorStatsByCommunity`), tambah card "Dokumen paling banyak
    diunduh"
  - Sistem warna tombol global dirapikan (radius pill, aturan hover/opacity/kontras
    konsisten) di `src/styles/tokens.css`
  - Tambah favicon (`icon-light.svg`) dan aset logo baru di `src/assets/`
- File terdampak: `src/components/layout/*` (baru), `src/pages/*.tsx`,
  `src/data/mock.ts`, `src/styles/tokens.css`, `src/App.tsx`, `index.html`,
  `src/assets/*` (baru)
- Catatan: banyak keputusan desain kecil diputuskan on-the-fly lewat obrolan
  panjang (bukan dari plan tertulis) — kalau mau, sesi depan bisa tulis ringkasan
  aturan desain ini jadi 1 plan/reference file di `Docs/` biar tidak hilang
  konteksnya. Favicon `icon-light.svg` warnanya nyaris putih (`#f4f7fa`) — kurang
  kontras di tab browser mode terang, mungkin perlu direvisi ke `icon-dark.svg`.

## [2026-09-06 15:40] Halaman detail Feed, floating chat, dan unifikasi post Feed

- Plan: - (kerjaan ad-hoc dari serangkaian revisi chat, bukan dari pending_works)
- Status: selesai penuh, sudah deploy ke production (commit `7315be9`, dikonfirmasi
  user berhasil)
- Perubahan:
  - Fix Sidebar: margin dikurangi 10px, padding submenu disamakan dengan menu
    parent (highlight submenu full-width)
  - Fix Discover: search bar dipindah ke bawah header + tombol "Cari Komunitas",
    lebar search+kategori disamakan dengan container "Semua komunitas" (grid kanan
    naik sejajar header), fix overflow grid dengan `minmax(0, 1fr)`
  - Halaman baru: Discussion Detail, Event Detail, Announcement Detail (masing-
    masing dengan sidebar rekomendasi/topik terkait, breadcrumb, scroll-to-top saat
    dibuka), rute baru di `App.tsx`
  - `calendarSchedule` di mock ditambah `id`/`description`/`hasLiveRoom` per item
  - Floating private chat global (`FloatingChat`, gaya LinkedIn): panel daftar
    percakapan + jendela chat mengambang (bisa banyak sekaligus, lebar 300px,
    minimize dengan klik header biru), fitur emoji/image/attachment, bisa dibuka
    dari ikon chat di kartu member (tab Anggota) lewat custom event
    `OPEN_CHAT_EVENT`
  - Community Feed dirombak jadi unified post stream (diskusi/pengumuman/materi/
    kegiatan, sempat ada "anggota" lalu dihapus lagi dari UI popup) via
    `FeedPostCard` + `PostEditorModal` (`src/components/feed/`): edit/hapus/share
    link per post, tag & silabus grouping (khusus Materi, bisa tambah manual),
    attachment image/video/audio/file, emoji; Materi/Kegiatan/Pengumuman cuma bisa
    dibuat admin (`myCreatedCommunityIds`)
  - Tombol "Posting" (hijau, ikon + bulat di kanan teks) buka modal create;
    search bar Feed simple (filter live saat ketik, tanpa tombol cari terpisah);
    filter & sortir jadi 2 ikon yang buka modal popup
  - Tambah ikon invite-member (modal undang via email) dan share-link komunitas di
    sebelah tombol Posting
  - Rename tab: Kalender jadi Kegiatan, Konten jadi Materi (termasuk label & link
    terkait)
  - Banner komunitas distandarkan (gradient langit/langit-dark utk semua komunitas),
    ikon invite lama di banner dihapus
  - Checkout: tambah navigasi "Kembali" & "Ke halaman komunitas"
- File terdampak:
  - Baru: `src/pages/DiscussionDetail.tsx`, `src/pages/EventDetail.tsx`,
    `src/pages/AnnouncementDetail.tsx`, `src/components/chat/FloatingChat.tsx`,
    `src/components/feed/FeedPostCard.tsx`, `src/components/feed/PostEditorModal.tsx`
  - Diubah: `src/App.tsx`, `src/components/layout/AppShell.tsx`,
    `src/components/layout/Sidebar.tsx`, `src/data/mock.ts`,
    `src/pages/Checkout.tsx`, `src/pages/CommunityHome.tsx`,
    `src/pages/Discover.tsx`, `src/styles/tokens.css`
- Catatan: karena tidak ada backend, post/percakapan/silabus baru yang dibuat lewat
  UI cuma hidup di state lokal komponen (hilang saat reload/pindah halaman) — kalau
  nanti mau dipertahankan lintas halaman perlu state global atau backend beneran.
  Belum ada plan tertulis untuk fitur-fitur ini; kalau area Feed/chat mau
  dikembangkan lagi, pertimbangkan buat plan file di `Docs/pending_works/` biar
  histori keputusan desainnya (mis. kenapa "Anggota" dihapus dari popup Posting)
  tidak hilang.
