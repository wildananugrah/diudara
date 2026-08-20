import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatRupiah } from "../api";
import {
  connectPayout,
  createOwnTier,
  deactivateOwnTier,
  getPayoutStatus,
  listOwnTiers,
  type PayoutStatus,
  type UserTier,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
// Moved to `tierCopy.ts` by Task 10, unchanged: the profile's offer renders
// the same tiers this editor does, and the two screens naming one billing
// cycle differently is a defect no test would notice.
import { billingCycleLabel } from "./tierCopy";

type PayoutLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; payout: PayoutStatus };

type TiersLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tiers: UserTier[] };

/**
 * The typed price as an integer of rupiah, or `null` when it is not one.
 *
 * Non-digits are DROPPED rather than refused, so "50.000" and "Rp 50.000" —
 * both of which an Indonesian will type, since that is how the price is
 * displayed back to them — mean 50000. A value that leaves no digits at all,
 * or leaves only zeros, is `null`: `ManageUserTiers.create` requires a
 * strictly positive integer (a free tier is not a membership anyone pays to
 * hold), and this returns nothing the server would refuse for that reason.
 */
function parsePriceAmount(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  const amount = Number.parseInt(digits, 10);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

/**
 * **Pengaturan's membership section: connect a payout account, then define
 * what you sell** (spec §5-§6). Task 9 of Phase 5a — the creator's half of the
 * first surface in this app where money moves.
 *
 * THE PAYOUT ACCOUNT HAS THREE STATES AND THIS SCREEN SHOWS THREE, not two.
 * `app_user.xendit_account_id` is NULL, or holds the
 * `provisioning:in-progress` sentinel that `ConnectUserPayout` writes before
 * it calls Xendit, or holds a real account id — and **the sentinel is
 * truthy**, which is exactly why every reader of that column goes through a
 * predicate rather than a truthiness check. Task 3 found that bug in its own
 * code; the server refuses the middle state everywhere (no tier may be
 * published against it, no membership may be bought against it), so a screen
 * that folded it into either neighbour would either promise a person they can
 * be paid when they cannot, or send them back round a connect loop for an
 * account they have already claimed — and each connect attempt provisions a
 * KYC entity at Xendit that has no delete endpoint.
 *
 * THE TIER EDITOR STAYS SHUT UNTIL THE ACCOUNT IS GENUINELY CONNECTED, with a
 * sentence saying which of the three states is in the way. Spec §5: a
 * membership whose money has nowhere to go is a trap for the buyer and the
 * seller both. `ManageUserTiers.create` enforces the same rule server-side
 * with a 409 — this is the same gate said early, not the only one.
 *
 * Every failure becomes a Bahasa sentence through `errorCopy.ts`. Note that
 * the 409 the server answers here carries Bahasa on the wire, which makes this
 * the easiest place in the app to justify printing what the server sent; the
 * rule is not "English is banned", it is that a screen never prints the wire's
 * text (`src/test/no-raw-server-errors.test.ts`).
 */
export default function MembershipSettings() {
  const [payoutLoad, setPayoutLoad] = useState<PayoutLoad>({ status: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPayoutStatus()
      .then((payout) => {
        if (!cancelled) setPayoutLoad({ status: "ready", payout });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPayoutLoad({
          status: "error",
          message: `Gagal memuat status pembayaran. ${describeRequestFailure(err)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connected = payoutLoad.status === "ready" && payoutLoad.payout.connected;

  async function handleConnect() {
    setConnectError(null);
    setConnecting(true);
    try {
      // The RESULTING state, which is not necessarily success: a caller that
      // loses the claim to another device is answered `provisioning: true`
      // having called the provider not at all. So this replaces the whole
      // status rather than assuming `connected`.
      const payout = await connectPayout();
      setPayoutLoad({ status: "ready", payout });
    } catch (err) {
      setConnectError(`Gagal menghubungkan akun pembayaran. ${describeRequestFailure(err)}`);
    } finally {
      setConnecting(false);
    }
  }

  return (
    <section className="card stack" aria-labelledby="membership-heading">
      <h2 id="membership-heading">Keanggotaan</h2>
      <p className="muted">
        Terima pembayaran dari pengikut Anda, lalu tentukan tingkatan keanggotaan yang Anda
        tawarkan di profil Anda.
      </p>

      <h3>Terima pembayaran</h3>
      {payoutLoad.status === "loading" ? <p className="muted">Memuat status pembayaran...</p> : null}
      {payoutLoad.status === "error" ? (
        <p className="form-error" role="alert">
          {payoutLoad.message}
        </p>
      ) : null}
      {payoutLoad.status === "ready" ? (
        <PayoutState
          payout={payoutLoad.payout}
          connecting={connecting}
          onConnect={() => void handleConnect()}
        />
      ) : null}
      {connectError !== null ? (
        <p className="form-error" role="alert">
          {connectError}
        </p>
      ) : null}

      <h3>Tingkatan keanggotaan</h3>
      {connected ? (
        <TierEditor />
      ) : (
        <p className="hint" data-testid="tier-editor-unavailable">
          {tierEditorUnavailableReason(payoutLoad)}
        </p>
      )}
    </section>
  );
}

/**
 * The three states of the payout column, plus the fourth thing
 * `GET /users/me/payout` reports: whether this deployment has a payment
 * provider at all. Four branches, and only ONE of them offers a button —
 * pressing connect while the sentinel is held cannot help (the claim is
 * already someone's), and pressing it on a box with no provider gets a 503.
 */
function PayoutState({
  payout,
  connecting,
  onConnect,
}: {
  payout: PayoutStatus;
  connecting: boolean;
  onConnect: () => void;
}) {
  if (!payout.available) {
    return (
      <p className="muted">
        Pembayaran belum tersedia di server ini. Hubungi dukungan DIUDARA jika Anda ingin mulai
        menerima pembayaran.
      </p>
    );
  }
  if (payout.connected) {
    return (
      <p>
        Akun pembayaran Anda sudah terhubung. Anda siap menerima pembayaran keanggotaan.
      </p>
    );
  }
  if (payout.provisioning) {
    return (
      <p>
        Akun pembayaran Anda sedang diverifikasi oleh Xendit. Pemeriksaan identitas ini bisa
        memakan waktu beberapa hari kerja, dan Anda tidak perlu menghubungkan ulang — kami akan
        memakai akun yang sudah Anda daftarkan.
      </p>
    );
  }
  return (
    <>
      <p>Anda belum menghubungkan akun pembayaran.</p>
      <div>
        <button type="button" className="button-primary" disabled={connecting} onClick={onConnect}>
          {connecting ? "Menghubungkan..." : "Hubungkan akun pembayaran"}
        </button>
      </div>
    </>
  );
}

/**
 * WHY the editor is shut, in the words that fit the state the person is
 * actually in. Every branch says that the money has nowhere to go — spec §5's
 * own reason — but only the one where connecting would help tells them to
 * connect. Telling somebody whose KYC is pending to "connect first" would send
 * them to press a button that provisions nothing and answers `provisioning`
 * again, and each press is a KYC entity at Xendit with no delete endpoint.
 *
 * The two NON-ready states get a sentence too, rather than the heading above
 * standing over nothing: a payout status that could not be read is a reason
 * the editor is shut, and it is one the person can act on by reloading.
 */
function tierEditorUnavailableReason(load: PayoutLoad): string {
  if (load.status === "loading") {
    return "Menunggu status akun pembayaran Anda.";
  }
  if (load.status === "error") {
    return (
      "Tingkatan keanggotaan belum bisa dibuat karena status akun pembayaran Anda tidak dapat " +
      "dibaca. Muat ulang halaman ini."
    );
  }
  const payout = load.payout;
  if (!payout.available) {
    return (
      "Tingkatan keanggotaan belum bisa dibuat karena pembayaran belum tersedia di server ini — " +
      "uang dari keanggotaan ini belum punya tempat tujuan."
    );
  }
  if (payout.provisioning) {
    return (
      "Tingkatan keanggotaan belum bisa dibuat karena akun pembayaran Anda masih menunggu " +
      "verifikasi. Sampai verifikasi selesai, uang dari keanggotaan ini belum punya tempat tujuan."
    );
  }
  return (
    "Hubungkan akun pembayaran Anda terlebih dahulu sebelum membuat tingkatan keanggotaan — " +
    "uang dari keanggotaan ini belum punya tempat tujuan."
  );
}

/**
 * Create and withdraw, which is the whole of what the server exposes: there is
 * no rename and no reprice, because `PATCH /users/me/tiers/:tierId` accepts
 * exactly `{ isActive: false }` and `UserTierRepositoryPort` has no
 * reactivate. Offering an "Edit" that could only ever fail would be worse than
 * not offering one, and changing the price of a tier people already hold is
 * explicitly out of scope (spec §11).
 *
 * Rendered only once the payout account is genuinely connected, so it never
 * has to reason about the sentinel itself.
 */
function TierEditor() {
  const [load, setLoad] = useState<TiersLoad>({ status: "loading" });
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listOwnTiers()
      .then((tiers) => {
        if (!cancelled) setLoad({ status: "ready", tiers });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: `Gagal memuat tingkatan keanggotaan. ${describeRequestFailure(err)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replaceTier = useCallback((updated: UserTier) => {
    setLoad((current) =>
      current.status === "ready"
        ? {
            status: "ready",
            tiers: current.tiers.map((tier) => (tier.id === updated.id ? updated : tier)),
          }
        : current
    );
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    // Checked HERE as well as on the server, and deliberately in the server's
    // own words. `ManageUserTiers.create` refuses both of these with a 400
    // whose message is Bahasa — but `describeRequestFailure` answers every
    // unlabelled 4xx with "Permintaan tidak dapat diproses", because it
    // chooses from the failure's SHAPE and a 400 carries no shape that says
    // which field was wrong. So a round trip would replace a precise sentence
    // with a vague one. The server stays the authority; this only keeps the
    // two mistakes a person actually makes answerable without a request.
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Nama tingkatan tidak boleh kosong.");
      return;
    }
    const priceAmount = parsePriceAmount(price);
    if (priceAmount === null) {
      setError("Harga tingkatan harus lebih dari nol.");
      return;
    }

    setSubmitting(true);
    try {
      const created = await createOwnTier({ name: trimmedName, priceAmount });
      setLoad((current) =>
        current.status === "ready"
          ? { status: "ready", tiers: [created, ...current.tiers] }
          : { status: "ready", tiers: [created] }
      );
      // Emptied on success, so a second tap on a slow connection cannot
      // publish the same tier twice — nothing server-side makes a tier unique
      // by name, so two identical tiers really would both be offered.
      setName("");
      setPrice("");
      setNotice("Tingkatan diterbitkan.");
    } catch (err) {
      setError(`Gagal menerbitkan tingkatan. ${describeRequestFailure(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate(tierId: string) {
    setError(null);
    setNotice(null);
    setPendingId(tierId);
    try {
      // The server's answer is the new row, so the list is updated from what
      // it returned rather than from what this client assumed it would do.
      replaceTier(await deactivateOwnTier(tierId));
      setNotice("Tingkatan tidak lagi ditawarkan.");
    } catch (err) {
      setError(`Gagal menonaktifkan tingkatan. ${describeRequestFailure(err)}`);
    } finally {
      setPendingId(null);
    }
  }

  const active = load.status === "ready" ? load.tiers.filter((tier) => tier.isActive) : [];
  const withdrawn = load.status === "ready" ? load.tiers.filter((tier) => !tier.isActive) : [];

  return (
    <div className="stack">
      <form onSubmit={handleCreate} className="stack" noValidate>
        <div className="field">
          <label htmlFor="membership-tier-name">Nama tingkatan</label>
          <input
            id="membership-tier-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="membership-tier-price">Harga per bulan (Rp)</label>
          {/*
            `inputMode="numeric"` rather than `type="number"`: this is money in
            rupiah, where a phone keypad is what is wanted but spinners and a
            browser's own decimal handling are not — the amount is an integer
            of rupiah, never a float.
          */}
          <input
            id="membership-tier-price"
            type="text"
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <p className="hint">Contoh: 50000 untuk Rp 50.000 per bulan.</p>
        </div>

        {error !== null ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice !== null ? <p className="form-ok">{notice}</p> : null}

        <button type="submit" className="button-primary" disabled={submitting}>
          {submitting ? "Menerbitkan..." : "Terbitkan tingkatan"}
        </button>
      </form>

      {load.status === "loading" ? <p className="muted">Memuat tingkatan...</p> : null}
      {load.status === "error" ? (
        <p className="form-error" role="alert">
          {load.message}
        </p>
      ) : null}

      {load.status === "ready" ? (
        <div data-testid="tier-offer" className="stack">
          <h4>Yang Anda tawarkan</h4>
          {active.length === 0 ? (
            <p className="muted">Belum ada tingkatan yang ditawarkan.</p>
          ) : (
            <ul className="card-list">
              {active.map((tier) => (
                <li key={tier.id} className="spread">
                  <span>{tier.name}</span>
                  <span className="muted">
                    {formatRupiah(tier.priceAmount)} {billingCycleLabel(tier.billingCycle)}
                  </span>
                  <button
                    type="button"
                    className="button-quiet"
                    disabled={pendingId === tier.id}
                    onClick={() => void handleDeactivate(tier.id)}
                  >
                    {pendingId === tier.id ? "Menonaktifkan..." : "Nonaktifkan"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {withdrawn.length > 0 ? (
        <div data-testid="tier-withdrawn" className="stack">
          <h4>Tidak lagi ditawarkan</h4>
          {/*
            Shown rather than hidden: deactivating never deletes the row (spec
            §4 — an existing member's subscription still resolves through it),
            and the server has no reactivate, so an owner who withdrew a tier
            by mistake needs to see that it still exists and that it is no
            longer on offer.
          */}
          <ul className="card-list">
            {withdrawn.map((tier) => (
              <li key={tier.id} className="spread">
                <span>{tier.name}</span>
                <span className="muted">
                  {formatRupiah(tier.priceAmount)} {billingCycleLabel(tier.billingCycle)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
