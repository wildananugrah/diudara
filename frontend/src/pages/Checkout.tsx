import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faArrowLeft, faUserGroup } from "@fortawesome/free-solid-svg-icons";
import Header from "../components/layout/Header";
import { api, ApiError } from "../lib/api";
import { useApi } from "../lib/useApi";
import { formatCount, formatRupiah } from "../lib/format";
import { FullPageMessage } from "../lib/auth";

type Step = "tier" | "payment" | "success";

export default function Checkout() {
  const { id } = useParams();
  const navigate = useNavigate();
  const communityId = id ?? "";

  const community = useApi(() => api.communities.detail(communityId), [communityId]);
  const tiers = useApi(() => api.communities.tiers(communityId), [communityId]);
  const methods = useApi(() => api.checkout.paymentMethods(), []);

  const [step, setStep] = useState<Step>("tier");
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [method, setMethod] = useState("qris");
  const [payError, setPayError] = useState("");
  const [paying, setPaying] = useState(false);
  const [paidTierName, setPaidTierName] = useState("");

  // Defaults to the highlighted tier, mirroring the mockup's pre-selected "Pro".
  const tierList = tiers.data ?? [];
  const activeTierId = selectedTier ?? tierList.find((t) => t.highlight)?.id ?? tierList[0]?.id ?? null;
  const tier = useMemo(() => tierList.find((t) => t.id === activeTierId) ?? null, [tierList, activeTierId]);

  const loading = community.loading || tiers.loading || methods.loading;
  const loadError = community.error ?? tiers.error ?? methods.error;

  if (loading) return <FullPageMessage text="Memuat checkout…" />;
  if (loadError) return <FullPageMessage text={loadError} tone="error" />;
  if (!community.data) return <FullPageMessage text="Komunitas tidak ditemukan" tone="error" />;

  const c = community.data;

  const pay = async () => {
    if (!tier) return;
    setPayError("");
    setPaying(true);
    try {
      const result = await api.checkout.subscribe(c.id, { tierId: tier.id, method });
      // A real gateway hands back a redirect/QR page; the current mock gateway
      // always returns null and a "paid" status, so this branch stays dormant
      // until one is wired in.
      if (result.redirectUrl) {
        window.location.href = result.redirectUrl;
        return;
      }
      setPaidTierName(result.tier.name);
      setStep("success");
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : "Pembayaran gagal, coba lagi.");
    } finally {
      setPaying(false);
    }
  };

  return (
    <>
      <Header
        title={`Checkout — ${c.name}`}
        subtitle={`${formatCount(c.memberCount)} member · ${c.category}`}
        insetDivider={false}
      />
      <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 620 }}>
        {/* Navigasi kembali */}
        <div style={{ display: "flex", gap: 18, marginBottom: 22 }}>
          <button
            onClick={() => navigate(-1)}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: "var(--ink-500)", fontSize: 13, fontWeight: 600 }}
          >
            <FontAwesomeIcon icon={faArrowLeft} /> Kembali
          </button>
          <button
            onClick={() => navigate(`/community/${c.id}`)}
            style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", color: "var(--ink-500)", fontSize: 13, fontWeight: 600 }}
          >
            <FontAwesomeIcon icon={faUserGroup} /> Ke halaman komunitas
          </button>
        </div>

        {/* Step indicator */}
        {step !== "success" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
            {["tier", "payment"].map((s, i) => (
              <div key={s} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 700,
                    background: step === s || (s === "tier" && step === "payment") ? "var(--langit)" : "var(--ink-150)",
                    color: step === s || (s === "tier" && step === "payment") ? "#fff" : "var(--ink-500)",
                  }}
                >
                  {i + 1}
                </div>
                <span style={{ fontSize: 13, fontWeight: 600, color: step === s ? "var(--langit)" : "var(--ink-500)" }}>
                  {s === "tier" ? "Pilih tier" : "Pembayaran"}
                </span>
                {i === 0 && <div style={{ flex: 1, height: 1.5, background: "var(--ink-150)" }} />}
              </div>
            ))}
          </div>
        )}

        {/* STEP: tier */}
        {step === "tier" && (
          <div>
            {tierList.length === 0 && (
              <p className="card" style={{ padding: 18, fontSize: 13.5, color: "var(--ink-500)", marginBottom: 20 }}>
                Komunitas ini belum menyiapkan tier membership.
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 24 }}>
              {tierList.map((t) => (
                <div
                  key={t.id}
                  onClick={() => setSelectedTier(t.id)}
                  className="card card-clickable"
                  style={{
                    padding: 20, position: "relative",
                    border: activeTierId === t.id ? "2px solid var(--sinyal)" : "1px solid var(--ink-150)",
                  }}
                >
                  {t.highlight && (
                    <span style={{ position: "absolute", top: -11, left: 20, background: "var(--sinyal)", color: "var(--ink-900)", fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999 }}>
                      Paling populer
                    </span>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <span style={{ fontSize: 16, fontWeight: 600 }}>{t.name}</span>
                    <span style={{ fontSize: 18, fontWeight: 700, color: "var(--langit)" }}>
                      {formatRupiah(t.priceCents)}
                      <span style={{ fontSize: 12.5, fontWeight: 400, color: "var(--ink-500)" }}>{t.billingPeriod}</span>
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {t.benefits.map((b, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--ink-700)" }}>
                        <span style={{ color: "var(--hijau-lepas)" }}><FontAwesomeIcon icon={faCheck} /></span>{b}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <button className="btn btn-primary btn-block" onClick={() => setStep("payment")} disabled={!tier}>
              Lanjut ke pembayaran
            </button>
          </div>
        )}

        {/* STEP: payment */}
        {step === "payment" && tier && (
          <div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
              {(methods.data ?? []).map((m) => (
                <div
                  key={m.id}
                  onClick={() => setMethod(m.id)}
                  className="card card-clickable"
                  style={{
                    padding: 16, display: "flex", alignItems: "center", gap: 14,
                    border: method === m.id ? "2px solid var(--sinyal)" : "1px solid var(--ink-150)",
                  }}
                >
                  <div
                    style={{
                      width: 20, height: 20, borderRadius: "50%", border: `2px solid ${method === m.id ? "var(--sinyal)" : "var(--ink-300)"}`,
                      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                    }}
                  >
                    {method === m.id && <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--sinyal)" }} />}
                  </div>
                  <div>
                    <p style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</p>
                    <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>{m.note}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ padding: 18, marginBottom: 20, background: "var(--awan)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, marginBottom: 8 }}>
                <span style={{ color: "var(--ink-500)" }}>Tier {tier.name}</span>
                <span style={{ fontWeight: 600 }}>{formatRupiah(tier.priceCents)}{tier.billingPeriod}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, paddingTop: 10, borderTop: "1px solid var(--ink-150)" }}>
                <span>Total</span>
                <span style={{ color: "var(--langit)" }}>{formatRupiah(tier.priceCents)}</span>
              </div>
            </div>

            {payError && (
              <p style={{ fontSize: 13, color: "var(--merah-senja)", marginBottom: 12 }}>{payError}</p>
            )}

            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setStep("tier")} disabled={paying}>Kembali</button>
              <button className="btn btn-primary btn-block" onClick={pay} disabled={paying}>
                {paying ? "Memproses pembayaran…" : `Bayar ${formatRupiah(tier.priceCents)}`}
              </button>
            </div>
          </div>
        )}

        {/* STEP: success */}
        {step === "success" && (
          <div className="card" style={{ padding: 36, textAlign: "center" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "var(--success-bg)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 26, color: "var(--hijau-lepas)" }}>
              <FontAwesomeIcon icon={faCheck} />
            </div>
            <h2 style={{ fontSize: 21, fontWeight: 600, marginBottom: 8 }}>Pembayaran berhasil</h2>
            <p style={{ fontSize: 14, color: "var(--ink-500)", marginBottom: 24, lineHeight: 1.55 }}>
              Kamu sudah terdaftar sebagai member tier <strong>{paidTierName}</strong> dan sekarang bisa
              mengakses seluruh materi komunitas ini.
            </p>
            <button className="btn btn-primary btn-block" onClick={() => navigate(`/community/${c.id}`)}>
              Masuk ke komunitas
            </button>
          </div>
        )}
      </div>
      </div>
    </>
  );
}
