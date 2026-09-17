# Session Prompts — DIUDARA Mockup

Copy-paste isi di dalam code block ke chat Claude Code (atau tool AI coding lain) di
awal dan akhir sesi kerja. Kalau kamu sudah pakai custom slash command
(`.claude/commands/start-session.md` dan `end-session.md`), file ini tidak wajib dipakai
— tapi berguna sebagai cadangan atau kalau kerja di environment lain yang tidak baca
slash command.

---

## START SESSION PROMPT

```
Mulai sesi kerja baru di project ini. Tujuan utama: hemat token — jangan baca file
yang tidak relevan dengan task yang akan dikerjakan.

Ikuti urutan ini secara ketat:

1. Baca Docs/SUMMARY.md dulu — ini ringkasan state project saat ini.

2. Baca Docs/LOG.md, tapi HANYA 3 entri paling akhir (bagian paling bawah file).
   Jangan baca seluruh log dari awal.

3. List isi folder Docs/pending_works/ (nama file saja, jangan buka isinya dulu).

4. Kalau saya sudah menyebutkan task/plan spesifik di prompt ini, langsung buka file
   .md yang relevan di Docs/pending_works/. Kalau belum jelas, tanya saya plan mana
   dari daftar pending_works yang mau dikerjakan sesi ini — jangan asumsi.

5. Setelah plan file dibuka, baca HANYA source code yang disebutkan eksplisit di plan
   tersebut. Jangan buka file lain di src/ kecuali plan menyebutkannya atau memang
   dibutuhkan langsung (misal tokens.css atau mock.ts kalau dipakai).

6. Jangan jalankan find, grep -r, atau list seluruh direktori src/ di awal sesi "untuk
   jaga-jaga". Baca sesuai kebutuhan plan saja. Kalau nanti butuh file lain saat
   eksekusi, baca saat itu juga (lazy loading), bukan di awal.

7. Setelah context di atas terbaca, kasih ringkasan singkat (3-5 baris): apa yang akan
   dikerjakan sesi ini, file apa saja yang akan disentuh, dan konfirmasi ke saya
   sebelum mulai eksekusi perubahan besar.

Jangan baca node_modules, dist, .git, atau file lock (package-lock.json) sama sekali
kecuali saya secara eksplisit minta debug dependency.
```

---

## END SESSION PROMPT

```
Sesi kerja akan ditutup. Lakukan langkah-langkah ini secara berurutan:

1. Rangkum perubahan sesi ini dalam poin-poin singkat: fitur/halaman apa yang
   dikerjakan, file apa saja yang ditambah/diubah/dihapus, dan status akhirnya
   (selesai penuh / sebagian / masih blocked dan kenapa).

2. Update file plan yang aktif di Docs/pending_works/<nama-plan>.md:
   - Centang (- [x]) item checklist yang sudah selesai di sesi ini.
   - Kalau plan tersebut sekarang SUDAH SELESAI SEPENUHNYA (semua checklist
     tercentang): pindahkan file itu dari Docs/pending_works/ ke
     Docs/completed_works/ (pakai mv, bukan copy). Tambahkan baris
     "Selesai: <tanggal>" di bagian atas file sebelum dipindah.
   - Kalau plan baru selesai sebagian: biarkan file tetap di pending_works/, cukup
     update checklist-nya dan tambahkan catatan singkat progres di bagian bawah file
     (bagian "Catatan progres").

3. Update Docs/SUMMARY.md:
   - Update bagian "Status saat ini" supaya mencerminkan state terbaru.
   - Kalau ada plan yang baru pindah ke completed_works, pindahkan juga referensinya
     dari daftar "Sedang dikerjakan" ke daftar "Sudah selesai" di SUMMARY.md.
   - Jangan tulis ulang seluruh file — hanya edit bagian yang berubah.

4. Tambahkan entri baru di Docs/LOG.md, di bagian PALING BAWAH file (append, jangan
   overwrite), dengan format:

   ## [YYYY-MM-DD HH:mm] <judul singkat sesi>
   - Plan: <nama file plan yang dikerjakan, atau "-" kalau tidak terkait plan>
   - Status: selesai penuh / sebagian / blocked
   - Perubahan:
     - <ringkasan perubahan 1>
     - <ringkasan perubahan 2>
   - File terdampak: <daftar file>
   - Catatan: <blocker, keputusan penting, atau hal yang perlu diperhatikan sesi depan>

5. Setelah semua file di atas diupdate, tampilkan ke saya: ringkasan singkat sesi ini
   (sama seperti poin 1), lokasi file yang berubah, dan apakah ada plan yang pindah ke
   completed_works.

Jangan lakukan git commit atau git push otomatis kecuali saya memintanya secara
eksplisit di sesi ini.
```
