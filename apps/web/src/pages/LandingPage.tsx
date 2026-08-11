import { Link } from "react-router-dom";

export default function LandingPage() {
  return (
    <main className="landing">
      <section className="landing-hero">
        <p className="landing-eyebrow">DIUDARA</p>
        <h1>Ubah grup Anda jadi komunitas berbayar</h1>
        <p className="landing-lede">
          DIUDARA menangani pembayaran, akses Telegram, dan perpanjangan otomatis untuk komunitas
          berbayar yang sudah Anda kelola. Anggota diberi tahu lewat WhatsApp, dan Anda tetap fokus
          ke konten.
        </p>
        <Link className="button-primary landing-cta" to="/dashboard/login">
          Mulai sekarang
        </Link>
      </section>

      <section className="landing-section">
        <h2>Mengelola komunitas berbayar itu melelahkan</h2>
        <ul className="landing-list">
          <li>Mengecek transfer masuk satu per satu.</li>
          <li>Menambahkan anggota baru secara manual, setiap hari.</li>
          <li>Tidak tahu siapa yang berhenti membayar — dan tidak sempat mengeluarkannya.</li>
        </ul>
      </section>

      <section className="landing-section">
        <h2>Tiga langkah</h2>
        <ol className="landing-steps">
          <li>
            <strong>Buat komunitas dan paket.</strong> Tentukan nama, harga, dan siklus penagihan.
          </li>
          <li>
            <strong>Bagikan tautan checkout.</strong> Setiap komunitas punya halaman pembayaran
            sendiri.
          </li>
          <li>
            <strong>Anggota bayar, akses diberikan otomatis.</strong> Undangan Telegram sekali
            pakai dikirim begitu pembayaran masuk.
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <h2>Yang Anda dapat</h2>
        <div className="landing-features">
          <article className="card landing-feature">
            <h3>Pembayaran QRIS &amp; e-wallet</h3>
            <p>
              Lewat Xendit. Dana anggota masuk ke sub-akun Anda sendiri, bukan ke rekening kami.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Akses Telegram otomatis</h3>
            <p>
              Undangan sekali pakai yang kedaluwarsa, dan pencabutan akses saat berhenti berlangganan.
              WhatsApp dipakai untuk mengirim notifikasi ke anggota.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Perpanjangan otomatis</h3>
            <p>
              Pengingat sebelum dan sesudah jatuh tempo, lalu pencabutan akses otomatis bila tidak
              diperpanjang.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Dashboard dan analitik</h3>
            <p>Jumlah anggota, pendapatan, churn, dan riwayat aktivitas komunitas Anda.</p>
          </article>
          <article className="card landing-feature">
            <h3>AI co-builder</h3>
            <p>
              Ceritakan komunitas Anda dalam Bahasa Indonesia, dan AI menyiapkan draf paket serta
              pesan sambutan yang tinggal Anda sunting.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-closing">
        <h2>Siap mencoba?</h2>
        <Link className="button-primary landing-cta" to="/dashboard/login">
          Mulai sekarang
        </Link>
      </section>
    </main>
  );
}
