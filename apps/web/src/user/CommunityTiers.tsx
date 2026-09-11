import { useEffect, useState } from "react";
import {
  createCommunityTier,
  deactivateCommunityTier,
  listCommunityTiers,
  subscribeToCommunity,
  type CommunityTierRow,
} from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { formatRupiah } from "../api";

interface Props {
  slug: string;
  viewerIsOwner: boolean;
  /** `true` member, `false` signed-in non-member, `null` signed out — `CommunityDetail`'s shape. */
  viewerIsMember: boolean | null;
}

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

/**
 * The community's membership offer, and the owner's management of it.
 *
 * **Reading is open**, like the feed, the calendar and the document list: a
 * paid community has to be evaluable before joining, and a price nobody can
 * see is not an offer.
 *
 * **Subscribing requires membership**, which the server enforces and this
 * component mirrors rather than duplicates — a non-member is shown the join
 * pointer instead of a button that would 403.
 */
export default function CommunityTiers({ slug, viewerIsOwner, viewerIsMember }: Props) {
  const [tiers, setTiers] = useState<CommunityTierRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // Separate from `load`: a failed subscribe must not replace the offer with
  // an error page — the tiers are still there and still readable.
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    listCommunityTiers(slug)
      .then((page) => {
        if (cancelled) return;
        setTiers(page.tiers);
        setLoad({ status: "ready" });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: describeRequestFailure(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  async function handleSubscribe(tier: CommunityTierRow): Promise<void> {
    setBusy(true);
    setActionError(null);
    try {
      const started = await subscribeToCommunity(slug, tier.id);
      // `invoiceUrl` is absent for exactly one reason — a FREE tier, where no
      // money moves and there is nothing to follow. The same branch
      // `MembershipOffer` takes for personal tiers.
      if (started.invoiceUrl === undefined) {
        window.location.reload();
        return;
      }
      window.location.href = started.invoiceUrl;
    } catch (error: unknown) {
      setActionError(`Langganan gagal dimulai. ${describeRequestFailure(error)}`);
      setBusy(false);
    }
  }

  async function handleCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      const created = await createCommunityTier(slug, {
        name,
        // The form holds a string; the API takes whole rupiah. An empty field
        // is 0, which is a FREE tier — a legal price, not an error.
        priceAmount: Number(price === "" ? 0 : price),
      });
      setTiers((current) => [...current, created]);
      setName("");
      setPrice("");
    } catch (error: unknown) {
      setActionError(`Tingkatan gagal dibuat. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate(tier: CommunityTierRow): Promise<void> {
    if (!window.confirm(`Berhenti menawarkan ${tier.name}? Anggota yang sudah ada tidak terpengaruh.`)) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await deactivateCommunityTier(slug, tier.id);
      // Removed from the OFFER, which is what deactivating means. Existing
      // subscriptions keep working — the server flips a flag rather than
      // deleting, because a subscription's foreign key needs the row.
      setTiers((current) => current.filter((row) => row.id !== tier.id));
    } catch (error: unknown) {
      setActionError(`Tingkatan gagal dinonaktifkan. ${describeRequestFailure(error)}`);
    } finally {
      setBusy(false);
    }
  }

  if (load.status === "loading") return <p>Memuat...</p>;
  if (load.status === "error") {
    return (
      <p className="form-error" role="alert">
        {load.message}
      </p>
    );
  }

  return (
    <section className="community-tiers">
      {actionError !== null ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {tiers.length === 0 ? (
        <p className="empty">Belum ada tingkatan keanggotaan.</p>
      ) : (
        <ul className="card-list tier-list">
          {tiers.map((tier) => (
            <li className="card tier-row" key={tier.id}>
              <span className="tier-detail">
                <span className="tier-name">{tier.name}</span>
                <span className="muted">
                  {tier.priceAmount === 0 ? "Gratis" : `${formatRupiah(tier.priceAmount)} / bulan`}
                </span>
              </span>
              {viewerIsOwner ? (
                <button type="button" disabled={busy} onClick={() => handleDeactivate(tier)}>
                  Nonaktifkan
                </button>
              ) : viewerIsMember === true ? (
                <button type="button" disabled={busy} onClick={() => handleSubscribe(tier)}>
                  Pilih
                </button>
              ) : (
                // Never a control for an action that would fail: the server
                // requires membership before checkout, so a non-member is
                // pointed at the join button rather than handed a 403.
                <span className="muted">
                  {viewerIsMember === null ? "Masuk untuk berlangganan" : "Gabung dulu"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {viewerIsOwner ? (
        <form className="tier-form" onSubmit={handleCreate}>
          <label htmlFor="tier-name">Nama tingkatan</label>
          <input
            id="tier-name"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="tier-price">Harga per bulan (Rp)</label>
          <input
            id="tier-price"
            type="number"
            min={0}
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
          <p className="muted">Isi 0 untuk tingkatan gratis.</p>
          <button type="submit" disabled={busy || name.trim() === ""}>
            Tambah tingkatan
          </button>
        </form>
      ) : null}
    </section>
  );
}
