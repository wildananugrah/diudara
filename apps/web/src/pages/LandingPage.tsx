import { Link } from "react-router-dom";

/**
 * The only page an unauthenticated visitor sees.
 *
 * **EVERY CLAIM ON THIS PAGE MUST POINT AT A ROUTE.** Phase 8 (retire-telegram)
 * found the previous copy selling a product that had been deleted underneath it:
 * the H1 offered to turn a group into a paid *community*, all three "Tiga
 * langkah" steps described communities and one-time Telegram invites — including
 * an instruction to share a `/c/:slug/checkout` link that 404s — and four of the
 * five feature cards advertised Telegram access, a creator dashboard with
 * analytics, an AI co-builder, and automatic renewals. All of that machinery is
 * gone. No test pinned any of it, so the suite stayed green the whole way down.
 *
 * The rewrite below describes only what ships, and `LandingPage.test.tsx` now
 * pins it four ways so the next deletion phase cannot leave it stale the same
 * way:
 *
 *   1. every `<a href>` on this page is rendered through the real `AppRoutes`
 *      and must not land on the 404 page (with a positive control proving the
 *      check can fail);
 *   2. the vocabulary of the deleted world is a denylist;
 *   3. the page may not promise automatic renewal, because nothing renews;
 *   4. the page must say that the TEXT of a members-only post stays readable.
 *
 * THE FOURTH ONE IS THERE BECAUSE THE FIRST REWRITE GOT IT WRONG. Removing a
 * false claim about a deleted feature and replacing it with a false claim about
 * a surviving one is the same defect wearing new clothes, and the re-review
 * caught exactly that: this page said "hanya anggota berbayar Anda yang bisa
 * membukanya" of a members-only post, and applied "Tandai yang khusus anggota"
 * to *tulisan*. Both are false, and false in the direction that matters — a
 * seller would design their posts around a paywall the product does not have.
 * Only the PHOTOS lock; the caption is deliberately public, because it is the
 * teaser that makes the lock convert (Phase 6), and a text-only post cannot be
 * members-only at all. Note that none of tests 1-3 could see this: no banned
 * word, no renewal promise, no link. A denylist catches the last product's
 * vocabulary; only a positive assertion catches THIS product being described
 * backwards.
 *
 * What each claim below rests on, so a future editor can re-check it rather than
 * trust this comment:
 *
 *   - selling from your own profile   `POST /users/me/tiers`, `MembershipOffer.tsx`,
 *                                     `<Route path="/:handleParam">`
 *   - connect payments first          `POST /users/me/payout`; `ManageUserTiers`
 *                                     refuses to publish a tier without a
 *                                     *connected* payout account
 *   - price per month                 `ManageUserTiers.ALLOWED_BILLING_CYCLES`
 *                                     is exactly `{"monthly"}`
 *   - "Jadi anggota"                  the literal button label in
 *                                     `MembershipOffer.tsx`; `POST /users/:handle/subscribe`
 *   - money to your own sub-account   `XenditPaymentAdapter` sends `for-user-id`
 *                                     (the seller's sub-account) with a split rule
 *                                     that routes only DIUDARA's fee elsewhere
 *   - photos lock, TEXT DOES NOT       `toPostView` (`post-views.ts`) returns
 *                                     `body` UNCONDITIONALLY and empties only
 *                                     `media`; `PostCard` renders the body
 *                                     outside its `locked ?` branch and shows
 *                                     "<n> foto terkunci" instead of the images
 *   - a locked post must have a photo  `requireImageWhenLocked` (`write-post.ts`)
 *                                     throws NO_IMAGE_FOR_MEMBERS_MESSAGE, and
 *                                     `PostComposer` disables *Khusus anggota*
 *                                     until an image is attached, saying so:
 *                                     "Tambahkan foto dulu — teks selalu bisa
 *                                     dibaca semua orang"
 *   - live streams, browser or OBS    `POST /streams` with the same two
 *                                     visibilities, `SiaranPage`'s WHIP publisher
 *                                     and its *Pakai OBS* block
 *   - reminders by email and WhatsApp `RemindExpiringMembership` — email always,
 *                                     plus WhatsApp when a number is on file
 *   - no recurring billing            `StartUserSubscription`: the Xendit adapter
 *                                     has two operations and no tokenisation, so
 *                                     "renew" means "buy again"
 *   - following is free               `POST /users/:handle/follow`, `GET /users/feed`,
 *                                     `GET /users/explore`
 *
 * No price and no percentage appears anywhere: the platform fee has never been
 * decided, and a test pins that too.
 */
export default function LandingPage() {
  return (
    <main className="landing">
      <section className="landing-hero">
        <p className="landing-eyebrow">DIUDARA</p>
        <h1>Jual keanggotaan langsung dari profil Anda</h1>
        <p className="landing-lede">
          Satu profil untuk tulisan, foto, dan siaran langsung Anda. Tulisannya terbuka
          untuk semua orang; fotonya bisa Anda kunci untuk anggota berbayar, begitu juga
          siaran langsung Anda — dan DIUDARA mengurus pembayarannya.
        </p>
        {/*
          Retire-telegram Task 1, fix round 1 (review Critical 1). Both
          `landing-cta` links used to point at `/dashboard/login`, the
          creator dashboard's own login screen — deleted by this same
          commit. Phase 8 is the resolution this comment (removed) used to
          say was still pending: with the dashboard gone, the new world's
          own signup is this page's only real entry point, so both CTAs
          point at the exact same place the `Daftar` link below does.
        */}
        <Link className="button-primary landing-cta" to="/signup">
          Mulai sekarang
        </Link>
        <p className="landing-entry-points">
          <Link to="/signup">Daftar</Link> · <Link to="/masuk">Masuk</Link>
        </p>
      </section>

      <section className="landing-section">
        <h2>Menjual karya berbayar itu melelahkan</h2>
        <ul className="landing-list">
          <li>Mengecek transfer masuk satu per satu.</li>
          <li>Mengingat sendiri siapa yang masih berhak membuka konten berbayar.</li>
          <li>Menitipkan karya ke tempat orang lain karena tidak punya halaman sendiri.</li>
        </ul>
      </section>

      <section className="landing-section">
        <h2>Tiga langkah</h2>
        <ol className="landing-steps">
          <li>
            <strong>Daftar dan hubungkan akun pembayaran.</strong> Paket keanggotaan baru
            bisa terbit setelah akun pembayaran Anda terhubung.
          </li>
          <li>
            <strong>Buat paket keanggotaan.</strong> Tentukan namanya dan harganya per
            bulan.
          </li>
          <li>
            <strong>Bagikan tautan profil Anda.</strong> Pengunjung menekan tombol
            &ldquo;Jadi anggota&rdquo; di profil itu, membayar, lalu bisa membuka foto
            dan siaran yang khusus anggota.
          </li>
        </ol>
      </section>

      <section className="landing-section">
        <h2>Yang Anda dapat</h2>
        <div className="landing-features">
          <article className="card landing-feature">
            <h3>Pembayaran lewat Xendit</h3>
            <p>Dana anggota masuk ke sub-akun Xendit Anda sendiri, bukan ke rekening bersama.</p>
          </article>
          <article className="card landing-feature">
            <h3>Foto untuk anggota, teks untuk semua</h3>
            <p>
              Tandai satu kiriman sebagai khusus anggota dan yang terkunci adalah fotonya:
              orang lain hanya melihat berapa foto yang tersembunyi, dengan tautan untuk
              jadi anggota. Teksnya sengaja tetap bisa dibaca siapa saja — itulah yang
              membuat orang ingin membukanya, dan karena itu kiriman khusus anggota harus
              punya sedikitnya satu foto.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Siaran langsung</h3>
            <p>
              Siaran dari peramban Anda, atau dari OBS lewat RTMP. Setiap siaran boleh
              terbuka untuk umum atau khusus anggota saja.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Pengingat sebelum masa aktif habis</h3>
            <p>
              Anggota diingatkan lewat email — dan lewat WhatsApp bila nomornya ada —
              menjelang masa keanggotaannya berakhir.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Tanpa tagihan berulang</h3>
            <p>
              Keanggotaan berlaku sebulan dan berhenti dengan sendirinya. Tidak ada
              penagihan diam-diam: anggota membeli lagi kalau memang mau melanjutkan.
            </p>
          </article>
          <article className="card landing-feature">
            <h3>Pengikut tanpa bayar</h3>
            <p>
              Siapa pun boleh mengikuti Anda tanpa membeli apa pun, membaca kiriman
              terbuka Anda di berandanya, dan menemukan Anda lewat halaman Discover.
            </p>
          </article>
        </div>
      </section>

      <section className="landing-closing">
        <h2>Siap mencoba?</h2>
        <Link className="button-primary landing-cta" to="/signup">
          Mulai sekarang
        </Link>
      </section>
    </main>
  );
}
