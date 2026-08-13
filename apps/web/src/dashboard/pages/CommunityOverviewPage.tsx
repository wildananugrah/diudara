import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import {
  ACCESS_MODES,
  accessModeExplanation,
  accessModeLabel,
  isRequestMode,
  communityStatusLabel,
  formatRupiah,
  memberStatusExplanation,
  memberStatusLabel,
} from "../format";
import {
  CheckoutLink,
  CommunityHeader,
  EmptyState,
  ErrorPanel,
  Field,
  NotFoundPanel,
  StatusExplanation,
} from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import type { Community, CommunityMetrics } from "../types";

/** `updateCommunitySchema`'s enum. Offering anything else would earn a 400. */
const STATUSES = ["active", "paused", "archived"] as const;

/**
 * WHY `ACCESS_MODES` (imported from ../format) IS RENDERED HERE AT ALL.
 *
 * Without a control bound to these, the whole free-communities phase is
 * unreachable: `access_mode` defaults to `paid` on every row, `CreateCommunity`
 * treats a missing value as `paid`, and no other screen in this app writes the
 * field — so a creator could never reach the request-mode checkout page
 * (`CheckoutPage.tsx`) or the join-request queue (`MembersPage.tsx`) that both
 * branch on it. Found by driving the real dashboard in a browser at the phase
 * gate, not by any test: every test on both of those screens supplies the mode
 * it wants as a fixture, so a green suite said nothing about whether anything
 * could produce it.
 */
/**
 * One community's overview: the numbers, what state it is in, the link to share,
 * and the three settings a creator actually changes.
 */
export default function CommunityOverviewPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [load, handle] = useCommunity(communityId);

  if (load.kind === "loading") return <p className="muted">Memuat...</p>;
  if (load.kind === "error") return <ErrorPanel message={load.message} onRetry={handle.reload} />;
  if (load.data === null) return <NotFoundPanel />;

  const community = load.data;

  return (
    <section>
      <CommunityHeader community={community} />

      <MetricsPanel community={community} />

      <div className="section card stack">
        <div>
          <h2>Status: {communityStatusLabel(community.status)}</h2>
          <StatusExplanation status={community.status} accessMode={community.accessMode} />
        </div>
        <CheckoutLink community={community} />
      </div>

      <div className="section card">
        <h2>Pengaturan</h2>
        <AccessModeForm community={community} onSaved={handle.update} />
        <StatusForm community={community} onSaved={handle.update} />
        <SlugForm community={community} onSaved={handle.update} />
      </div>
    </section>
  );
}

/**
 * One metric tile: a label, the figure, and WHAT THE FIGURE MEANS.
 *
 * The note is not decoration. Every number on this screen is one a creator can
 * misread — gross revenue as take-home pay, past-due as locked-out — and a tile
 * without its note is a number with no units.
 */
function Metric({
  testId,
  label,
  value,
  note,
}: {
  testId: string;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="metric" data-testid={testId}>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      <p className="metric-note">{note}</p>
    </div>
  );
}

/**
 * The numbers a creator opens the dashboard for.
 *
 * ITS OWN `useLoad`, NOT the community's, so a metrics failure costs the creator
 * the numbers and nothing else — the checkout link they were about to copy and the
 * status they were about to change are still on the screen behind it.
 *
 * ============================ REVENUE IS GROSS ============================
 * `grossRevenueAmount` is the sum of SUCCESSFUL transactions BEFORE DIUDARA's
 * platform fee. Xendit's split rule deducts that fee before a single Rupiah
 * reaches the creator, so this figure is NOT what they earned and must never be
 * labelled as if it were. There is no endpoint that reports the fee or the net, so
 * the honest thing available is to name the figure "kotor (bruto)" and say in the
 * tile that the fee comes out of it. Labelling it "Pendapatan Anda" would overstate
 * a creator's income on the first screen they see — a correctness bug, not copy.
 * ==========================================================================
 */
function MetricsPanel({ community }: { community: Community }) {
  const [load, handle] = useLoad(
    () => apiFetch<CommunityMetrics>(`/communities/${community.id}/metrics`),
    [community.id]
  );

  if (load.kind === "loading") return <p className="muted">Memuat angka...</p>;
  if (load.kind === "error") {
    return (
      <div className="section">
        <ErrorPanel message={load.message} onRetry={handle.reload} />
      </div>
    );
  }

  const metrics = load.data;
  const freeCommunity = isRequestMode(community);
  const { active, pastDue, churned } = metrics.members;
  // "How many people can currently see my group" and "how many are paid up" are
  // different questions, which is exactly why the API reports past-due separately
  // instead of folding it into active. Both answers are on the screen.
  const withAccess = active + pastDue;
  const nothingYet =
    active === 0 && pastDue === 0 && churned === 0 && metrics.grossRevenueAmount === 0;

  if (nothingYet) {
    // A grid of zeroes on day one reads as a broken panel rather than as a new
    // community, so it says what to do next instead.
    //
    // The tier list stays, though: a creator who has just defined their packages
    // needs to see them confirmed, and one who has not needs to be told that is the
    // next thing to do. Replacing the whole panel would hide both.
    return (
      <div className="section stack">
        <div data-testid="metrics-empty">
          {/* A free community can NEVER have a first payment, so the paid
              wording here told its creator to wait for something that will
              never happen. */}
          <EmptyState
            title={
              freeCommunity ? "Belum ada anggota" : "Belum ada anggota dan belum ada pembayaran"
            }
            action={
              freeCommunity
                ? "Sebarkan tautan pendaftaran di bawah ke calon anggota. Angka keanggotaan muncul di sini setelah Anda menyetujui permintaan pertama."
                : "Sebarkan tautan checkout di bawah ke calon anggota. Angka keanggotaan dan pendapatan muncul di sini setelah pembayaran pertama berhasil."
            }
          />
        </div>
        <TierDistribution tiers={metrics.tierDistribution} community={community} />
      </div>
    );
  }

  return (
    <div className="section stack">
      <div className="metrics">
        <Metric
          testId="metric-gross-revenue"
          label="Pendapatan kotor (bruto)"
          value={formatRupiah(metrics.grossRevenueAmount)}
          note="Total pembayaran yang berhasil, SEBELUM biaya platform DIUDARA. Xendit memotong biaya itu sebelum dana diteruskan, jadi jumlah yang masuk ke rekening lebih kecil dari angka ini."
        />
        <Metric
          testId="metric-with-access"
          label="Bisa mengakses grup"
          value={String(withAccess)}
          note={`Aktif (${active}) + lewat jatuh tempo (${pastDue}). Ini jumlah orang yang saat ini masih ada di dalam grup Anda.`}
        />
        <Metric
          testId="metric-active"
          label={`Anggota ${memberStatusLabel("active").toLowerCase()}`}
          value={String(active)}
          note={memberStatusExplanation("active")}
        />
        <Metric
          testId="metric-past-due"
          label={memberStatusLabel("past_due")}
          value={String(pastDue)}
          note={memberStatusExplanation("past_due")}
        />
        <Metric
          testId="metric-churned"
          label={memberStatusLabel("churned")}
          value={String(churned)}
          note={memberStatusExplanation("churned")}
        />
      </div>

      <TierDistribution tiers={metrics.tierDistribution} community={community} />
    </div>
  );
}

/**
 * Members per tier, INCLUDING TIERS NOBODY HAS BOUGHT.
 *
 * The zero rows are the point rather than padding: a tier with no members is a
 * price nobody accepted or a package nobody saw, and it is invisible in any view
 * that only lists what sold.
 */
function TierDistribution({
  tiers,
  community,
}: {
  tiers: CommunityMetrics["tierDistribution"];
  community: Community;
}) {
  if (tiers.length === 0) {
    return (
      <EmptyState
        title="Belum ada paket"
        action={
          isRequestMode(community)
            ? "Buat paket di tab “Paket”. Tanpa paket aktif, halaman pendaftaran Anda tidak menawarkan apa pun untuk diikuti."
            : "Buat paket di tab “Paket”. Tanpa paket aktif, halaman checkout Anda tidak menawarkan apa pun untuk dibeli."
        }
      />
    );
  }

  return (
    <div>
      <h2>Anggota per paket</h2>
      <div className="table-scroll" data-testid="tier-distribution">
        <table>
          <thead>
            <tr>
              <th>Paket</th>
              <th className="numeric">Harga</th>
              <th className="numeric">Anggota aktif</th>
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.tierId} data-testid={`tier-row-${tier.tierId}`}>
                <td>{tier.tierName}</td>
                <td className="numeric">{formatRupiah(tier.priceAmount)}</td>
                <td className="numeric">{tier.activeMembers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Hanya anggota berstatus aktif yang dihitung di sini.{" "}
        {isRequestMode(community)
          ? "Paket yang menunjukkan 0 anggota belum pernah disetujui untuk siapa pun."
          : "Paket yang menunjukkan 0 anggota belum pernah dibeli siapa pun."}
      </p>
    </div>
  );
}

/** `PATCH /communities/:id` with the one field being changed, never the whole record. */
async function patchCommunity(
  communityId: string,
  patch: Record<string, unknown>
): Promise<Community> {
  return apiFetch<Community>(`/communities/${communityId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * THE CONTROL THAT MAKES FREE COMMUNITIES REACHABLE. See `ACCESS_MODES` above
 * for what was broken without it.
 *
 * Shows the explanation for the mode CURRENTLY SELECTED IN THE SELECT, not the
 * one currently saved — a creator reading "what happens if I do this" before
 * pressing Simpan is the whole point, and `StatusForm`'s own separate
 * `StatusExplanation` (which reports the saved value up beside the heading) is
 * a different job at a different place on the page.
 *
 * A 409 here is the payments-disabled server refusing `paid`
 * (`CreateCommunity`/`UpdateCommunity`, apps/api) and its message is already
 * Indonesian and already actionable, so it is rendered verbatim rather than
 * replaced — the same call `MembersPage`'s join-request queue makes for the two
 * 409s it does not recognise.
 */
function AccessModeForm({
  community,
  onSaved,
}: {
  community: Community;
  onSaved: (next: Community) => void;
}) {
  const [accessMode, setAccessMode] = useState(community.accessMode);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      onSaved(await patchCommunity(community.id, { accessMode }));
    } catch (err) {
      // The creator's choice is deliberately NOT reverted — they have to change
      // something to get past a refusal, and resetting the select would hide
      // what they just tried, exactly as `SlugForm` reasons about its own field.
      setMessage(err instanceof Error ? err.message : "gagal menyimpan cara bergabung");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="inline-form">
        <Field label="Cara bergabung" name="access-mode">
          <select
            id="field-access-mode"
            value={accessMode}
            onChange={(e) => setAccessMode(e.target.value)}
          >
            {ACCESS_MODES.map((value) => (
              <option key={value} value={value}>
                {accessModeLabel(value)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="muted" data-testid="access-mode-explanation">
        {accessModeExplanation(accessMode)}
      </p>
      {message !== null ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="button-secondary" disabled={saving}>
          {saving ? "Menyimpan..." : "Simpan cara bergabung"}
        </button>
      </div>
    </form>
  );
}

function StatusForm({
  community,
  onSaved,
}: {
  community: Community;
  onSaved: (next: Community) => void;
}) {
  const [status, setStatus] = useState(community.status);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      onSaved(await patchCommunity(community.id, { status }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "gagal menyimpan status");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="inline-form">
        <Field label="Status" name="status">
          <select id="field-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {communityStatusLabel(value)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {message !== null ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="button-secondary" disabled={saving}>
          {saving ? "Menyimpan..." : "Simpan status"}
        </button>
      </div>
    </form>
  );
}

function SlugForm({
  community,
  onSaved,
}: {
  community: Community;
  onSaved: (next: Community) => void;
}) {
  const [slug, setSlug] = useState(community.slug);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});
    setSaving(true);
    try {
      onSaved(await patchCommunity(community.id, { slug }));
    } catch (err) {
      // The slug the creator typed is NOT reverted: they have to change it anyway,
      // and resetting the field would make them retype the whole thing.
      if (err instanceof DashboardApiError) {
        if (err.status === 409) {
          setMessage(
            "Alamat tautan itu sudah dipakai. Coba yang lain — alamat tautan harus unik di seluruh DIUDARA."
          );
        } else {
          setFieldErrors(err.fieldErrors);
          setMessage(Object.keys(err.fieldErrors).length > 0 ? null : err.message);
        }
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="inline-form">
        <Field
          label="Alamat tautan (slug)"
          name="slug"
          error={fieldErrors.slug}
          hint="Huruf kecil, angka dan tanda hubung tunggal. Mengubahnya MEMATIKAN tautan lama yang sudah Anda sebarkan."
        >
          <input
            id="field-slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            aria-invalid={fieldErrors.slug !== undefined}
          />
        </Field>
      </div>
      {message !== null ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}
      <div>
        <button type="submit" className="button-secondary" disabled={saving}>
          {saving ? "Menyimpan..." : "Simpan tautan"}
        </button>
      </div>
    </form>
  );
}
