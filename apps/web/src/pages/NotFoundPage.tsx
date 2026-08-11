import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <main className="landing landing-notfound">
      <h1>Halaman tidak ditemukan</h1>
      <p className="landing-lede">
        Tautan yang Anda buka mungkin salah ketik atau sudah tidak berlaku.
      </p>
      <Link className="button-primary landing-cta" to="/">
        Kembali ke beranda
      </Link>
    </main>
  );
}
