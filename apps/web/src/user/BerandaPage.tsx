import { Link } from "react-router-dom";

/**
 * `/beranda` — Phase 3 owns the real two-tab feed (Untuk Anda / Mengikuti,
 * see the member-UI spec §2). Until then this is an HONEST placeholder, not
 * a spinner: there is no feed to load yet, so a skeleton would never
 * resolve, which is worse than a sentence saying so.
 */
export default function BerandaPage() {
  return (
    <main className="user-page">
      <h1>Beranda</h1>
      <p>Belum ada kiriman untuk ditampilkan.</p>
      <p>
        Temukan orang untuk diikuti di <Link to="/jelajah">Jelajah</Link>.
      </p>
    </main>
  );
}
