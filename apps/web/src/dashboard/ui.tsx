import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { apiFetch } from "./apiClient";
import { subscribeToAuth } from "./auth";
import {
  communityStatusExplanation,
  communityStatusLabel,
  publicCheckoutUrl,
  publicLinkLabel,
} from "./format";
import { ensurePaymentAccountStatusLoaded, getPaymentAccountState } from "./paymentAccount";
import type { AiStatus, Community, StreamingStatus } from "./types";

/** A label, its input, and that field's own error message. Shared by every form. */
export function Field({
  label,
  name,
  error,
  hint,
  children,
}: {
  label: string;
  name: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{label}</label>
      {children}
      {hint !== undefined ? <p className="hint">{hint}</p> : null}
      {error !== undefined ? (
        <p className="field-error" data-testid={`error-${name}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What an empty list says.
 *
 * `action` is not optional by accident: a brand-new creator sees an empty
 * communities list, an empty tier list, an empty channel list, an empty roster and
 * an empty feed ON DAY ONE, and a panel that only says "nothing here" reads as
 * broken. Every one of them has to say what to do next.
 */
export function EmptyState({ title, action }: { title: string; action: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <div>{action}</div>
    </div>
  );
}

/** A failed load, with the reason and a way to retry. Never a blank panel. */
export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card">
      <h2>Gagal memuat data</h2>
      <p className="muted">{message}</p>
      {onRetry !== undefined ? (
        <button type="button" className="button-secondary" onClick={onRetry}>
          Coba lagi
        </button>
      ) : null}
    </div>
  );
}

export function NotFoundPanel() {
  return (
    <div className="card">
      <h2>Komunitas tidak ditemukan</h2>
      <p className="muted">
        Tautan ini mungkin salah, atau komunitas ini bukan milik akun yang sedang masuk.
      </p>
      <Link to="/dashboard">Kembali ke daftar komunitas</Link>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status.replace(/_/g, "-")}`}>{communityStatusLabel(status)}</span>;
}

/**
 * THE LINK A CREATOR BROADCASTS, in full and copyable.
 *
 * Shown as text as well as being copyable on purpose: `navigator.clipboard` needs a
 * secure context and can be denied, and the whole product depends on the creator
 * getting this link into WhatsApp. If the copy fails they can still read it and
 * select it by hand, and the failure says so rather than pretending it worked.
 */
export function CopyableLink({ url, label }: { url: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div>
      <p className="hint">{label}</p>
      <div className="copy-row">
        <code>{url}</code>
        <button type="button" className="button-secondary" onClick={copy}>
          {state === "copied" ? "Tersalin" : "Salin"}
        </button>
      </div>
      {state === "failed" ? (
        <p className="hint">Tidak bisa menyalin otomatis — salin manual dari kotak di atas.</p>
      ) : null}
    </div>
  );
}

/**
 * "You cannot sell yet", shown wherever a creator is about to build something
 * nobody can buy.
 *
 * Renders nothing once the SERVER has confirmed the account connected.
 * Everything else — including "still loading" — gets the warning, because a
 * creator building tiers behind a missing payment account is the failure this
 * exists to prevent: `StartCheckout` answers every purchase with 409 "this
 * community is not ready to accept payments yet", and nothing else in the
 * product would tell them.
 *
 * The answer comes from `GET /payment-account` (see `paymentAccount.ts`), so —
 * unlike the `localStorage` design this replaced — it is the same on every
 * device the creator opens the dashboard from.
 *
 * SUBSCRIBED, not read during render, and it kicks the fetch off itself on
 * mount. This used to call `getPaymentAccountState()` straight out of
 * `localStorage` with nothing watching it, so connecting payments on the
 * account screen left every OTHER mounted screen still warning that nobody
 * could buy anything until a navigation happened to re-render it — the
 * creator had just fixed the problem and was still being told they had it.
 * `useSyncExternalStore` over the session notifier is the same mechanism
 * `RequireAuth` uses for an expiring token, and the snapshot is a string, so
 * React's `Object.is` comparison settles immediately.
 */
export function PaymentAccountNotice() {
  const state = useSyncExternalStore(subscribeToAuth, getPaymentAccountState);
  useEffect(() => {
    ensurePaymentAccountStatusLoaded();
  }, []);
  if (state === "connected") return null;

  return (
    <div className="notice notice-warning" data-testid="payment-account-notice" role="status">
      <h3>
        {state === "provisioning"
          ? "Penghubungan pembayaran sedang diproses — anggota belum bisa membayar"
          : "Pembayaran belum terhubung — anggota belum bisa membayar"}
      </h3>
      <p>
        Tanpa akun pembayaran yang aktif, setiap pembelian ditolak dengan pesan “komunitas ini belum
        siap menerima pembayaran”. Paket yang Anda buat tidak akan bisa dibeli siapa pun.
      </p>
      <p>
        Buka <Link to="/dashboard/account">Akun &amp; pembayaran</Link> lalu tekan “Hubungkan
        pembayaran”. Jika Anda sudah pernah menghubungkannya, tombol itu akan menjawab “sudah
        terhubung” dan peringatan ini akan hilang di semua perangkat Anda.
      </p>
    </div>
  );
}

/** The breadcrumb, name, status and per-community navigation every community screen shares. */
export function CommunityHeader({ community }: { community: Community }) {
  const base = `/dashboard/c/${community.id}`;
  return (
    <header className="section">
      {/* The name is NOT repeated here. It is the h1 below, and a breadcrumb that
          echoed it would make every `getByText(name)` ambiguous and every screen
          reader announce it twice. */}
      <p className="breadcrumb">
        <Link to="/dashboard">&larr; Semua komunitas</Link>
      </p>
      <div className="row">
        <h1>{community.name}</h1>
        <StatusBadge status={community.status} />
      </div>
      {community.niche !== null ? <p className="muted">{community.niche}</p> : null}
      <nav className="tabs" aria-label="Navigasi komunitas">
        <NavLink to={base} end>
          Ringkasan
        </NavLink>
        <NavLink to={`${base}/tiers`}>Paket</NavLink>
        <NavLink to={`${base}/channels`}>Grup</NavLink>
        <NavLink to={`${base}/members`}>Anggota</NavLink>
        <NavLink to={`${base}/activity`}>Aktivitas</NavLink>
        <LiveStreamingNavLink communityId={community.id} />
      </nav>
    </header>
  );
}

/** The community's status, and what that status actually does. */
export function StatusExplanation({ status }: { status: string }) {
  return (
    <p className="muted" data-testid="status-explanation">
      {communityStatusExplanation(status)}
    </p>
  );
}

/**
 * The AI co-builder's nav entry — shown ONLY once `GET /ai/status` confirms a
 * provider is actually configured on this server.
 *
 * FAILS TOWARD HIDING, the opposite direction from `PaymentAccountNotice`
 * (which fails toward showing its warning). The two have different stakes: a
 * warning that fails to show risks a creator building tiers nobody can buy;
 * a nav link that fails to show costs nothing but one entry a creator never
 * sees, versus a SHOWN link that is wrong costing them a dead click into a
 * screen that can only ever answer 503 — see routes/ai.ts's docstring: "the
 * dashboard is expected to call this once ... and hide the chat screen
 * entirely rather than ever reach POST /ai/messages on a disabled box."
 *
 * Fetched once per mount rather than cached across the session the way
 * `paymentAccount.ts` caches its answer: whether a provider is configured is
 * decided once at server boot (env vars), not by anything a creator does
 * inside this browser, so there is no cross-tab "just changed" state to keep
 * in step with — an in-memory module-level cache would only add a second
 * place this could go stale.
 */
export function AiCoBuilderNavLink() {
  const [status, setStatus] = useState<"loading" | "enabled" | "disabled">("loading");

  useEffect(() => {
    let cancelled = false;
    apiFetch<AiStatus>("/ai/status")
      .then((result) => {
        if (!cancelled) setStatus(result.enabled ? "enabled" : "disabled");
      })
      .catch(() => {
        // A 401 here means a redirect to login is already in flight (see
        // apiClient.ts); anything else is treated the same as "disabled" —
        // failing toward hiding rather than showing a link that cannot work.
        if (!cancelled) setStatus("disabled");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status !== "enabled") return null;
  return <NavLink to="/dashboard/co-builder">AI Co-Builder</NavLink>;
}

/**
 * The "Siaran langsung" community tab — hidden until `GET /streaming/status`
 * confirms live streaming is configured on this server. SAME PATTERN as
 * `AiCoBuilderNavLink` immediately above (fetch once on mount, fail toward
 * HIDING on any error, no cross-session cache — see that component's own
 * docstring for why each of those choices is made), reused rather than
 * reinvented per Task 7's brief.
 *
 * `GET /streaming/status` exists FOR this — Task 3 deliberately left "how
 * does the dashboard learn this without a side effect" to whichever task
 * built this screen (see events.ts's own history): the only alternative
 * signal, `POST /communities/:communityId/events`'s 503, cannot be probed
 * for without actually scheduling a real session on success, which is the
 * exact reason `paymentAccount.ts` refuses to probe `POST /payment-account`.
 *
 * Takes `communityId` (unlike `AiCoBuilderNavLink`, which has no props)
 * because this tab lives inside a specific community's own navigation, not
 * the top-level one — `EventsPage` is mounted at
 * `/dashboard/c/:communityId/streaming`.
 */
export function LiveStreamingNavLink({ communityId }: { communityId: string }) {
  const [status, setStatus] = useState<"loading" | "enabled" | "disabled">("loading");

  useEffect(() => {
    let cancelled = false;
    apiFetch<StreamingStatus>("/streaming/status")
      .then((result) => {
        if (!cancelled) setStatus(result.enabled ? "enabled" : "disabled");
      })
      .catch(() => {
        if (!cancelled) setStatus("disabled");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status !== "enabled") return null;
  return <NavLink to={`/dashboard/c/${communityId}/streaming`}>Siaran langsung</NavLink>;
}

export function CheckoutLink({ community }: { community: Community }) {
  return (
    <CopyableLink url={publicCheckoutUrl(community.slug)} label={publicLinkLabel(community)} />
  );
}
