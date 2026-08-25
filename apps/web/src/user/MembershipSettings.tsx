import { useCallback, useEffect, useState, type FormEvent } from "react";
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
import { billingCycleLabel, formatTierPrice } from "./tierCopy";

type PayoutLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; payout: PayoutStatus };

type TiersLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; tiers: UserTier[] };

/**
 * The typed price, classified into the three shapes `handleCreate` has to
 * answer differently — "free memberships" is exactly the change that split
 * what used to be one `null` into two distinct refusals.
 *
 * `"empty"` — no digits at all. Still an error (there is nothing to publish
 * a tier at), and still refused before the server is ever asked.
 *
 * `"negative"` — the one input that is genuinely nonsense, matched on a
 * literal `-` ANYWHERE in the string rather than on the parsed sign: digits
 * are extracted with `\D` below, which strips a minus sign along with every
 * thousands separator, so "-50000" would otherwise silently become the
 * POSITIVE amount 50000 — accepting the exact input the API refuses. `Harga
 * tingkatan tidak boleh negatif.` is `ManageUserTiers.create`'s own wording
 * for this refusal (`manage-user-tiers.ts`); this mirrors it verbatim so the
 * two surfaces never disagree about why a negative price is refused.
 *
 * `"amount"` — a non-negative integer, and **`0` is a legal amount now**,
 * meaning a FREE tier: `ManageUserTiers.create`'s own gate is
 * `priceAmount < 0`, never `priceAmount <= 0`, since Task 3 of this phase.
 * The old version of this function folded "empty" and "not positive" into
 * one `null`, which is exactly what made a free tier unreachable from this
 * screen — the API would have accepted `0`, but this function turned it into
 * the same nothing an empty box produces, before the API was ever called.
 *
 * Non-digits (aside from the sign check above) are still DROPPED rather than
 * refused, so "50.000" and "Rp 50.000" — both of which an Indonesian will
 * type, since that is how the price is displayed back to them — mean 50000.
 */
type ParsedPrice = { kind: "empty" } | { kind: "negative" } | { kind: "amount"; value: number };

function parsePriceAmount(raw: string): ParsedPrice {
  const isNegative = raw.includes("-");
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return { kind: "empty" };
  const amount = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(amount)) return { kind: "empty" };
  if (isNegative) return { kind: "negative" };
  return { kind: "amount", value: amount };
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
 * THE TIER EDITOR ONLY STAYS SHUT WHILE THE PAYOUT STATUS ITSELF IS UNKNOWN
 * (still loading, or unreadable) — not merely because the account is not yet
 * connected. That used to be the same gate: before "free memberships"
 * (Task 3 on the API side), every tier needed a connected payout account, so
 * closing the whole editor until one existed was the correct read of spec §5.
 * It no longer is. `ManageUserTiers.create` now skips its payout check
 * entirely for a `priceAmount === 0` tier — no money ever moves for one, so
 * there is nothing for a payout account to receive — and a screen that still
 * refused to even show the form would make a free tier just as unreachable as
 * a paid one on a deployment with no payout account, exactly the gap Task 7 of
 * "free memberships" exists to close. `TierEditor` below reads `payout` itself
 * now, and only a PAID tier (`priceAmount > 0`) submitted without a connected
 * account round-trips to the server's own 409 — the same gate, still said
 * early where it can be, just no longer over the whole form.
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
      {payoutLoad.status === "ready" ? (
        <TierEditor payout={payoutLoad.payout} />
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
 * WHY the editor is shut — which, since Task 7 of "free memberships", is only
 * while `payoutLoad` itself has not resolved to a real answer: still loading,
 * or unreadable after an error. Both are reasons the FORM cannot be shown
 * responsibly (a free-tier submission is possible either way, but the screen
 * has nothing to tell the person about paid tiers until it knows), and the
 * error case is one the person can act on themselves by reloading.
 *
 * Every OTHER payout state — not connected, mid-provisioning, no provider at
 * all on this deployment — used to shut the editor too, back when every tier
 * needed a connected account. It no longer does: those three now open
 * `TierEditor`, which reads `payout` itself and says what a payout account
 * would still be needed for.
 */
function tierEditorUnavailableReason(
  load: Extract<PayoutLoad, { status: "loading" | "error" }>
): string {
  if (load.status === "loading") {
    return "Menunggu status akun pembayaran Anda.";
  }
  return (
    "Tingkatan keanggotaan belum bisa dibuat karena status akun pembayaran Anda tidak dapat " +
    "dibaca. Muat ulang halaman ini."
  );
}

/**
 * A tier's price line, the way both lists below render it — "Gratis" alone
 * for a free tier, never "Gratis per bulan": `billingCycle` is stored on
 * every row (the column is NOT NULL) but means nothing for a free one —
 * nothing downstream reads it to renew or re-charge a membership that never
 * charges — so pairing it with "Gratis" would name a cadence that does not
 * apply. A paid tier still reads price and cycle together, exactly as before.
 */
function tierPriceLine(tier: UserTier): string {
  return tier.priceAmount === 0
    ? formatTierPrice(tier.priceAmount)
    : `${formatTierPrice(tier.priceAmount)} ${billingCycleLabel(tier.billingCycle)}`;
}

/**
 * Create and withdraw, which is the whole of what the server exposes: there is
 * no rename and no reprice, because `PATCH /users/me/tiers/:tierId` accepts
 * exactly `{ isActive: false }` and `UserTierRepositoryPort` has no
 * reactivate. Offering an "Edit" that could only ever fail would be worse than
 * not offering one, and changing the price of a tier people already hold is
 * explicitly out of scope (spec §11).
 *
 * Rendered once the payout STATUS is known, whether or not an account is
 * actually connected — Task 7 of "free memberships" (see `MembershipSettings`'s
 * own docstring). `payout` is read here, not to gate the form shut, but to
 * tell the person up front when only a free tier is reachable: submitting a
 * PAID tier without a connected account still round-trips to the server's own
 * 409, this is only the warning said early.
 */
function TierEditor({ payout }: { payout: PayoutStatus }) {
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
        // Read defensively, same as `SubscriberList`/`MembershipRequests`:
        // this is a screen, not a contract test, and a response that cannot
        // be parsed into the expected shape should read as empty rather than
        // throw `.filter` past this component and take Pengaturan down with
        // it — reachable now that `TierEditor` mounts regardless of payout
        // state, on any test (or real deployment) whose `/users/me/tiers`
        // answers something else entirely.
        if (!cancelled) setLoad({ status: "ready", tiers: Array.isArray(tiers) ? tiers : [] });
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

    // Checked HERE as well as on the server, in the server's own words where
    // the server has one. `ManageUserTiers.create` refuses an empty name and
    // a negative price with a 400 whose message is Bahasa — but
    // `describeRequestFailure` answers every unlabelled 4xx with "Permintaan
    // tidak dapat diproses", because it chooses from the failure's SHAPE and
    // a 400 carries no shape that says which field was wrong. So a round trip
    // would replace a precise sentence with a vague one. The server stays the
    // authority; this only keeps the mistakes a person actually makes
    // answerable without a request. An EMPTY price box has no server
    // counterpart to mirror — there is nothing to send — so that sentence is
    // this screen's own, not a copy of the wire's.
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("Nama tingkatan tidak boleh kosong.");
      return;
    }
    const parsedPrice = parsePriceAmount(price);
    if (parsedPrice.kind === "empty") {
      setError("Harga tingkatan wajib diisi. Isi 0 untuk tingkatan gratis.");
      return;
    }
    if (parsedPrice.kind === "negative") {
      // The API's own wording (`ManageUserTiers.create`), matched verbatim —
      // see `parsePriceAmount`'s own docstring for why.
      setError("Harga tingkatan tidak boleh negatif.");
      return;
    }
    const priceAmount = parsedPrice.value;

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
          <p className="hint">
            Contoh: 50000 untuk Rp 50.000 per bulan, atau 0 untuk tingkatan gratis.
          </p>
        </div>

        {/*
          Said early, in the payout section's own words, rather than only
          discovered as a 409 after pressing submit — but NOT a block: a free
          tier (harga 0) needs no payout account at all, so the form stays
          open and only a paid submission actually round-trips to the
          server's own refusal. See `TierEditor`'s own docstring.
        */}
        {!payout.connected ? (
          <p className="hint">
            Tingkatan gratis (harga 0) bisa diterbitkan sekarang. Untuk tingkatan berbayar,
            hubungkan akun pembayaran Anda terlebih dahulu di atas.
          </p>
        ) : null}

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
                  <span className="muted">{tierPriceLine(tier)}</span>
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
                <span className="muted">{tierPriceLine(tier)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
