import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  fetchCommunity,
  formatRupiah,
  startCheckout,
  submitJoinRequest,
  type PublicCommunity,
  type PublicTier,
} from "../api";

/** `community.accessMode` value that accepts a free join request instead of a purchase. */
const REQUEST_ACCESS_MODE = "request";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; community: PublicCommunity };

export default function CheckoutPage() {
  const { slug } = useParams<{ slug: string }>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!slug) {
      setLoad({ status: "not-found" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    fetchCommunity(slug)
      .then((community) => {
        if (!cancelled) setLoad({ status: "ready", community });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setLoad({ status: "not-found" });
        } else {
          setLoad({ status: "error", message: err instanceof Error ? err.message : "failed to load community" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (load.status === "loading") {
    return <Centered>Memuat...</Centered>;
  }

  if (load.status === "not-found") {
    return (
      <Centered>
        <h1 style={styles.heading}>Komunitas tidak ditemukan</h1>
        <p>Tautan ini mungkin salah atau sudah tidak berlaku.</p>
      </Centered>
    );
  }

  if (load.status === "error") {
    return (
      <Centered>
        <h1 style={styles.heading}>Gagal memuat halaman</h1>
        <p>{load.message}</p>
      </Centered>
    );
  }

  const { community } = load;

  if (!community.acceptingNewMembers) {
    return (
      <Centered>
        <h1 style={styles.heading}>{community.name}</h1>
        <p>Komunitas ini untuk sementara tidak menerima anggota baru. Coba lagi lain waktu.</p>
      </Centered>
    );
  }

  if (community.tiers.length === 0) {
    return (
      <Centered>
        <h1 style={styles.heading}>{community.name}</h1>
        <p>Belum ada paket keanggotaan yang tersedia untuk komunitas ini.</p>
      </Centered>
    );
  }

  return <TierPicker community={community} />;
}

/**
 * `RequestToJoin`'s 409s (`"permintaan Anda sudah menunggu persetujuan..."`,
 * `"Anda sudah menjadi anggota komunitas ini..."`) are already Indonesian and
 * safe to show verbatim — see request-to-join.ts. Everything else is not:
 * a 404 when the community or tier disappeared between page load and submit
 * (accessMode flipped to paid, the community paused, the tier deactivated —
 * all reachable in ordinary use, not hypothetical) throws `NotFoundError`
 * with an English internal message ("community not found", "tier not
 * found") never meant for a member to read, and a 500 or network failure is
 * no better. One Indonesian line a member can act on covers all of those.
 */
function requestErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return err.message;
  }
  return "Permintaan gagal dikirim. Coba lagi, atau muat ulang halaman ini.";
}

function TierPicker({ community }: { community: PublicCommunity }) {
  const isRequestMode = community.accessMode === REQUEST_ACCESS_MODE;
  // In REQUEST mode only: a community with exactly one active tier answers a
  // question that has only one answer, so the tier is picked automatically
  // and no picker renders. Paid mode always shows the picker regardless of
  // tier count — unlike request mode, price is the one thing a paid member
  // must see before pressing "Lanjutkan pembayaran", and price only ever
  // renders inside this picker. Gating this on tier count alone (rather than
  // "|| !isRequestMode") once meant a single-tier PAID community rendered a
  // purchase form with no price and no tier name at all — caught in review.
  const showPicker = community.tiers.length > 1 || !isRequestMode;
  const [tierId, setTierId] = useState<string>(community.tiers[0]!.id);
  const [payerName, setPayerName] = useState("");
  const [payerWhatsappNumber, setPayerWhatsappNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isRequestMode) {
        const result = await submitJoinRequest(community.slug, { tierId, payerName, payerWhatsappNumber });
        navigate(`/c/${community.slug}/request/${result.joinRequestId}`);
        return;
      }
      const result = await startCheckout(community.slug, { tierId, payerName, payerWhatsappNumber });
      window.location.href = result.invoiceUrl;
    } catch (err) {
      setSubmitting(false);
      if (isRequestMode) {
        setError(requestErrorMessage(err));
      } else {
        setError(err instanceof Error ? err.message : "checkout gagal, coba lagi");
      }
    }
  }

  return (
    <main style={styles.page}>
      <h1 style={styles.heading}>{community.name}</h1>
      {community.niche ? <p style={styles.niche}>{community.niche}</p> : null}
      {isRequestMode ? <h2 style={styles.requestHeading}>Ajukan bergabung</h2> : null}

      <form onSubmit={handleSubmit} style={styles.form}>
        {showPicker ? (
          <fieldset style={styles.fieldset}>
            <legend style={styles.legend}>Pilih paket</legend>
            {community.tiers.map((tier) => (
              <TierOption
                key={tier.id}
                tier={tier}
                selected={tier.id === tierId}
                onSelect={() => setTierId(tier.id)}
                showPrice={!isRequestMode}
              />
            ))}
          </fieldset>
        ) : null}

        <label style={styles.label}>
          Nama
          <input
            style={styles.input}
            type="text"
            required
            value={payerName}
            onChange={(e) => setPayerName(e.target.value)}
            autoComplete="name"
          />
        </label>

        <label style={styles.label}>
          Nomor WhatsApp
          <input
            style={styles.input}
            type="tel"
            required
            placeholder="+6281234567890"
            value={payerWhatsappNumber}
            onChange={(e) => setPayerWhatsappNumber(e.target.value)}
            autoComplete="tel"
          />
        </label>

        {error ? <p style={styles.error}>{error}</p> : null}

        <button type="submit" disabled={submitting} style={styles.button}>
          {submitting ? "Memproses..." : isRequestMode ? "Kirim permintaan" : "Lanjutkan pembayaran"}
        </button>
      </form>
    </main>
  );
}

function TierOption({
  tier,
  selected,
  onSelect,
  showPrice,
}: {
  tier: PublicTier;
  selected: boolean;
  onSelect: () => void;
  showPrice: boolean;
}) {
  return (
    <label style={styles.tierOption}>
      <input type="radio" name="tier" checked={selected} onChange={onSelect} />
      <span style={styles.tierName}>{tier.name}</span>
      {showPrice ? (
        <span style={styles.tierPrice}>
          {formatRupiah(tier.priceAmount)} / {billingCycleLabel(tier.billingCycle)}
        </span>
      ) : null}
    </label>
  );
}

function billingCycleLabel(cycle: string): string {
  switch (cycle) {
    case "monthly":
      return "bulan";
    case "quarterly":
      return "3 bulan";
    case "yearly":
      return "tahun";
    default:
      return cycle;
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main style={styles.centered}>{children}</main>;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 480,
    margin: "0 auto",
    padding: "24px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  centered: {
    maxWidth: 480,
    margin: "0 auto",
    padding: "48px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    textAlign: "center",
  },
  heading: {
    fontSize: "1.5rem",
    marginBottom: 4,
  },
  niche: {
    color: "#555",
    marginTop: 0,
    marginBottom: 24,
  },
  // Deliberately smaller and muted, not styles.heading verbatim — with a
  // null niche, an identically-sized heading 4px below the community name
  // reads as two competing titles instead of a section label under one.
  requestHeading: {
    fontSize: "1.1rem",
    fontWeight: 600,
    color: "#333",
    marginTop: 0,
    marginBottom: 16,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  fieldset: {
    border: "1px solid #ddd",
    borderRadius: 8,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  legend: {
    fontWeight: 600,
    padding: "0 4px",
  },
  tierOption: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: 8,
    border: "1px solid #eee",
    borderRadius: 6,
    fontSize: "1rem",
  },
  tierName: {
    flex: 1,
  },
  tierPrice: {
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: "0.9rem",
  },
  input: {
    fontSize: "1rem",
    padding: "10px 12px",
    border: "1px solid #ccc",
    borderRadius: 6,
  },
  button: {
    fontSize: "1.05rem",
    padding: "14px 16px",
    borderRadius: 8,
    border: "none",
    background: "#16a34a",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  error: {
    color: "#b91c1c",
    margin: 0,
  },
};
