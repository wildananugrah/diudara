import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFire, faArrowRight, faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { formatCount, formatRupiah } from "../lib/format";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";
import CreateCommunityModal from "../components/community/CreateCommunityModal";

export default function Discover() {
  const [activeCategory, setActiveCategory] = useState("Semua");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  // Fetched once, then filtered client-side — same behaviour the mockup had, so
  // typing stays instant and does not fire a request per keystroke.
  const communitiesReq = useApi(useCallback(() => api.communities.list(), []));
  const categoriesReq = useApi(useCallback(() => api.communities.categories(), []));
  const tagsReq = useApi(useCallback(() => api.communities.trendingTags(), []));

  const communities = communitiesReq.data ?? [];
  const categories = categoriesReq.data ?? ["Semua"];
  const trendingTags = tagsReq.data ?? [];

  const filtered = communities.filter((c) => {
    const matchCategory = activeCategory === "Semua" || c.category === activeCategory;
    const matchQuery = c.name.toLowerCase().includes(query.toLowerCase()) || c.niche.toLowerCase().includes(query.toLowerCase());
    return matchCategory && matchQuery;
  });

  const liveNow = communities.filter((c) => c.isLive);

  return (
    <>
      <Header
        title="Discover"
        subtitle="Gabung komunitas yang cocok dengan minatmu"
      />
      <PageContainer>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 20 }}>
        <div>
          {/* Search bar */}
          <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
            <input
              className="input"
              placeholder="Cari komunitas, topik, atau mentor..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, background: "var(--awan)" }}
            />
            <button className="btn btn-primary" style={{ flexShrink: 0 }}>
              <FontAwesomeIcon icon={faMagnifyingGlass} /> Cari Komunitas
            </button>
          </div>

          {/* Category filters */}
          <div style={{ display: "flex", gap: 8, overflowX: "auto", marginBottom: 28 }} className="scrollbar-none">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className="btn btn-sm"
                style={{
                  background: activeCategory === cat ? "var(--langit)" : "var(--surface)",
                  color: activeCategory === cat ? "var(--awan)" : "var(--ink-700)",
                  border: activeCategory === cat ? "none" : "1px solid var(--ink-150)",
                  flexShrink: 0,
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Live now strip */}
          {liveNow.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                <span className="live-badge"><span className="dot"></span>LIVE</span>
                <h3 style={{ fontSize: 16, fontWeight: 600 }}>Sedang berlangsung</h3>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 20 }}>
                {liveNow.map((c) => (
                  <div
                    key={c.id}
                    onClick={() => navigate(`/live/${c.id}`)}
                    className="card card-clickable"
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{ height: 100, background: `linear-gradient(135deg, ${c.color}, var(--langit-dark))`, position: "relative", padding: 12 }}>
                      <span className="live-badge"><span className="dot"></span>LIVE</span>
                      <span style={{ position: "absolute", bottom: 10, right: 12, fontSize: 12, color: "#fff", fontWeight: 600, background: "rgba(0,0,0,0.35)", padding: "3px 8px", borderRadius: 999 }}>
                        {c.liveViewers} nonton
                      </span>
                    </div>
                    <div style={{ padding: 14 }}>
                      <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{c.name}</p>
                      <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>{c.niche}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Community grid */}
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 14 }}>
            {activeCategory === "Semua" ? "Semua komunitas" : activeCategory}
            {!communitiesReq.loading && !communitiesReq.error && (
              <span style={{ color: "var(--ink-500)", fontWeight: 400 }}> · {filtered.length} hasil</span>
            )}
          </h3>

          {communitiesReq.loading && (
            <p style={{ fontSize: 13.5, color: "var(--ink-500)", padding: "18px 0" }}>Memuat komunitas…</p>
          )}

          {communitiesReq.error && (
            <div className="card" style={{ padding: 18, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
              <p style={{ fontSize: 13.5, color: "var(--merah-senja)" }}>{communitiesReq.error}</p>
              <button className="btn btn-ghost btn-sm" onClick={communitiesReq.reload}>Coba lagi</button>
            </div>
          )}

          {!communitiesReq.loading && !communitiesReq.error && filtered.length === 0 && (
            <p style={{ fontSize: 13.5, color: "var(--ink-500)", padding: "18px 0" }}>
              Tidak ada komunitas yang cocok dengan pencarianmu.
            </p>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 20 }}>
            {filtered.map((c) => (
              <div
                key={c.id}
                onClick={() => navigate(`/community/${c.id}`)}
                className="card card-clickable"
                style={{ padding: 20, display: "flex", flexDirection: "column", gap: 12 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div
                    style={{
                      width: 40, height: 40, borderRadius: 11, background: c.color,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "#fff", fontWeight: 700, fontFamily: "var(--font-display)", fontSize: 16,
                    }}
                  >
                    {c.name.charAt(0)}
                  </div>
                  {c.trending && (
                    <span className="badge badge-pending">
                      <FontAwesomeIcon icon={faFire} /> Trending
                    </span>
                  )}
                </div>
                <div>
                  <p style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 4, lineHeight: 1.3 }}>{c.name}</p>
                  <p style={{ fontSize: 13, color: "var(--ink-500)", lineHeight: 1.5 }}>{c.description}</p>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "auto", paddingTop: 6 }}>
                  <span style={{ fontSize: 12.5, color: "var(--ink-500)" }}>{formatCount(c.memberCount)} member</span>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--langit)" }}>
                    {formatRupiah(c.priceCents)}
                    <span style={{ fontWeight: 400, color: "var(--ink-500)" }}>{c.billingPeriod}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sidebar */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {trendingTags.length > 0 && (
            <div className="card" style={{ padding: 18 }}>
              <h4 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12, color: "var(--ink-700)" }}>Tag populer</h4>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {trendingTags.map((tag) => (
                  <span key={tag} className="badge badge-neutral">{tag}</span>
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ padding: 18, background: "var(--langit)", color: "var(--awan)", border: "none" }}>
            <p style={{ fontSize: 12.5, fontWeight: 700, color: "var(--sinyal-light)", marginBottom: 8, letterSpacing: 0.3 }}>
              PUNYA KOMUNITAS SENDIRI?
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 14, color: "#D9E2EA" }}>
              Setup komunitas berbayar kamu dalam 15 menit bareng Pulse-ID.
            </p>
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              Mulai sekarang <FontAwesomeIcon icon={faArrowRight} />
            </button>
          </div>
        </div>
      </div>
      </PageContainer>

      {creating && (
        <CreateCommunityModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            navigate(`/community/${id}`);
          }}
        />
      )}
    </>
  );
}
