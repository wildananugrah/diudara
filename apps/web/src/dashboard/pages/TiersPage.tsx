import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import {
  billingCycleLabel,
  billingCycleOptionLabel,
  formatRupiah,
  isRequestMode,
} from "../format";
import {
  CommunityHeader,
  EmptyState,
  ErrorPanel,
  Field,
  NotFoundPanel,
  PaymentAccountNotice,
} from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import type { Tier } from "../types";

/**
 * Only these three. `createTierSchema`'s enum is the authority; an option the API
 * would reject has no business being offered.
 */
const BILLING_CYCLES = ["monthly", "quarterly", "yearly"] as const;

/**
 * PRICES ARE INTEGER RUPIAH, and this is where that is enforced on the way in.
 *
 * Rupiah has no minor unit in practice and `createTierSchema` requires
 * `z.number().int()`, so "50000,50" or "50.000" must never become a float on the
 * way to the API. Digits only, checked before the request is sent, so the creator
 * gets a message about the field rather than a 400 about a body.
 *
 * Grouping separators are tolerated on input (`1.250.000` is how an Indonesian
 * writes it) and stripped; a decimal comma is NOT, because 50000,50 is a real
 * intention that this product cannot honour and silently truncating it would
 * mis-price a tier.
 */
function parseRupiahInput(raw: string): { amount: number } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Harga wajib diisi." };
  if (/[.,]\d{1,2}$/.test(trimmed) && /[,]/.test(trimmed)) {
    return { error: "Harga harus bilangan bulat Rupiah, tanpa desimal." };
  }
  const digits = trimmed.replace(/\./g, "");
  if (!/^\d+$/.test(digits)) {
    return { error: "Harga harus bilangan bulat Rupiah (hanya angka), misalnya 1250000." };
  }
  const amount = Number(digits);
  if (!Number.isSafeInteger(amount)) {
    return { error: "Harga harus bilangan bulat Rupiah." };
  }
  return { amount };
}

export default function TiersPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [communityLoad] = useCommunity(communityId);
  const [tiersLoad, tiersHandle] = useLoad(
    () => apiFetch<Tier[]>(`/communities/${communityId}/tiers`),
    [communityId]
  );

  if (communityLoad.kind === "loading") return <p className="muted">Memuat...</p>;
  if (communityLoad.kind === "error") return <ErrorPanel message={communityLoad.message} />;
  if (communityLoad.data === null) return <NotFoundPanel />;

  const freeCommunity = isRequestMode(communityLoad.data);

  return (
    <section>
      <CommunityHeader community={communityLoad.data} />
      <h2>Paket keanggotaan</h2>
      <PaymentAccountNotice />

      {tiersLoad.kind === "loading" ? <p className="muted">Memuat paket...</p> : null}
      {tiersLoad.kind === "error" ? (
        <ErrorPanel message={tiersLoad.message} onRetry={tiersHandle.reload} />
      ) : null}

      {tiersLoad.kind === "ready" ? (
        <>
          <div className="section">
            {tiersLoad.data.length === 0 ? (
              <EmptyState
                title="Belum ada paket"
                action={
                  freeCommunity
                    ? "Tambahkan satu paket di bawah. Sebelum ada paket aktif, halaman pendaftaran Anda tidak menawarkan apa pun untuk diikuti."
                    : "Tambahkan satu paket di bawah. Sebelum ada paket aktif, halaman checkout Anda tidak menawarkan apa pun untuk dibeli."
                }
              />
            ) : (
              <TierTable
                tiers={tiersLoad.data}
                freeCommunity={freeCommunity}
                communityId={communityId!}
                onUpdated={(tier) =>
                  tiersHandle.update(tiersLoad.data.map((t) => (t.id === tier.id ? tier : t)))
                }
              />
            )}
          </div>
          <CreateTierForm
            communityId={communityId!}
            onCreated={(tier) => tiersHandle.update([...tiersLoad.data, tier])}
          />
        </>
      ) : null}
    </section>
  );
}

function TierTable({
  tiers,
  communityId,
  freeCommunity,
  onUpdated,
}: {
  tiers: Tier[];
  communityId: string;
  /** A request-mode community has no checkout, so "dibeli" is false for it. */
  freeCommunity: boolean;
  onUpdated: (tier: Tier) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(tier: Tier) {
    setBusyId(tier.id);
    setError(null);
    try {
      const updated = await apiFetch<Tier>(`/communities/${communityId}/tiers/${tier.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !tier.isActive }),
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "gagal mengubah paket");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Paket</th>
              <th className="numeric">Harga</th>
              <th>Siklus</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tiers.map((tier) => (
              <tr key={tier.id}>
                <td>{tier.name}</td>
                <td className="numeric">{formatRupiah(tier.priceAmount)}</td>
                <td>{billingCycleLabel(tier.billingCycle)}</td>
                <td>
                  <span className={`badge ${tier.isActive ? "badge-active" : "badge-churned"}`}>
                    {tier.isActive ? "Aktif" : "Nonaktif"}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="button-quiet"
                    onClick={() => toggle(tier)}
                    disabled={busyId === tier.id}
                  >
                    {tier.isActive ? "Nonaktifkan" : "Aktifkan"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        {freeCommunity
          ? "Paket nonaktif tidak muncul di halaman pendaftaran dan tidak bisa diminta. Anggota yang sudah disetujui untuk paket itu tidak terpengaruh dan tetap punya akses."
          : "Paket nonaktif tidak muncul di halaman checkout dan tidak bisa dibeli. Anggota yang sudah membeli paket itu tidak terpengaruh dan tetap diperpanjang."}
      </p>
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function CreateTierForm({
  communityId,
  onCreated,
}: {
  communityId: string;
  onCreated: (tier: Tier) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [billingCycle, setBillingCycle] = useState<string>("monthly");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});

    const parsed = parseRupiahInput(price);
    if ("error" in parsed) {
      // No request at all: money never becomes a float on the way out.
      setFieldErrors({ priceAmount: parsed.error });
      return;
    }

    setSubmitting(true);
    try {
      const created = await apiFetch<Tier>(`/communities/${communityId}/tiers`, {
        method: "POST",
        body: JSON.stringify({ name, priceAmount: parsed.amount, billingCycle }),
      });
      setName("");
      setPrice("");
      onCreated(created);
    } catch (err) {
      if (err instanceof DashboardApiError) {
        setFieldErrors(err.fieldErrors);
        setMessage(Object.keys(err.fieldErrors).length > 0 ? null : err.message);
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Tambah paket</h3>
      <form onSubmit={submit} className="stack" noValidate>
        <div className="inline-form">
          <Field label="Nama paket" name="name" error={fieldErrors.name}>
            <input
              id="field-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fieldErrors.name !== undefined}
            />
          </Field>
          <Field
            label="Harga per siklus (Rupiah)"
            name="priceAmount"
            error={fieldErrors.priceAmount}
            hint="Bilangan bulat tanpa desimal, misalnya 1250000 untuk Rp 1.250.000."
          >
            <input
              id="field-priceAmount"
              // `text`, not `number`: a number input silently accepts `1e5` and
              // localised decimals, and its value is a string anyway. The parse
              // above is the real check.
              type="text"
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              aria-invalid={fieldErrors.priceAmount !== undefined}
            />
          </Field>
          <Field label="Siklus penagihan" name="billingCycle" error={fieldErrors.billingCycle}>
            <select
              id="field-billingCycle"
              value={billingCycle}
              onChange={(e) => setBillingCycle(e.target.value)}
            >
              {BILLING_CYCLES.map((cycle) => (
                <option key={cycle} value={cycle}>
                  {billingCycleOptionLabel(cycle)}
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
          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Menyimpan..." : "Tambah paket"}
          </button>
        </div>
      </form>
    </div>
  );
}
