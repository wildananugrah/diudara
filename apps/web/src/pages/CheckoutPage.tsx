import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { ApiError, fetchCommunity, formatRupiah, startCheckout, type PublicCommunity, type PublicTier } from "../api";

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

function TierPicker({ community }: { community: PublicCommunity }) {
  const [tierId, setTierId] = useState<string>(community.tiers[0]!.id);
  const [payerName, setPayerName] = useState("");
  const [payerWhatsappNumber, setPayerWhatsappNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await startCheckout(community.slug, { tierId, payerName, payerWhatsappNumber });
      window.location.href = result.invoiceUrl;
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : "checkout gagal, coba lagi");
    }
  }

  return (
    <main style={styles.page}>
      <h1 style={styles.heading}>{community.name}</h1>
      {community.niche ? <p style={styles.niche}>{community.niche}</p> : null}

      <form onSubmit={handleSubmit} style={styles.form}>
        <fieldset style={styles.fieldset}>
          <legend style={styles.legend}>Pilih paket</legend>
          {community.tiers.map((tier) => (
            <TierOption key={tier.id} tier={tier} selected={tier.id === tierId} onSelect={() => setTierId(tier.id)} />
          ))}
        </fieldset>

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
          {submitting ? "Memproses..." : "Lanjutkan pembayaran"}
        </button>
      </form>
    </main>
  );
}

function TierOption({ tier, selected, onSelect }: { tier: PublicTier; selected: boolean; onSelect: () => void }) {
  return (
    <label style={styles.tierOption}>
      <input type="radio" name="tier" checked={selected} onChange={onSelect} />
      <span style={styles.tierName}>{tier.name}</span>
      <span style={styles.tierPrice}>
        {formatRupiah(tier.priceAmount)} / {billingCycleLabel(tier.billingCycle)}
      </span>
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
