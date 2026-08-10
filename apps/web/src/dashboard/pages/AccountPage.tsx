import { useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch, DashboardApiError } from "../apiClient";
import { getCreator, subscribeToAuth } from "../auth";
import {
  ensurePaymentAccountStatusLoaded,
  getPaymentAccountState,
  paymentAccountStateFromConflict,
  recordPaymentAccountState,
} from "../paymentAccount";

type Outcome =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "connected"; accountId: string | null; alreadyWas: boolean }
  | { kind: "in-progress" }
  | { kind: "failed"; message: string };

/**
 * Connecting payments — the one thing a creator must do before anybody can buy
 * anything.
 *
 * `GET /payment-account` reports whether it is already done — see
 * `paymentAccount.ts` for how that answer is cached and shared with
 * `PaymentAccountNotice` on every other screen. `POST /payment-account` is
 * still the only way to CONNECT, and it stays behind a button a person
 * presses rather than running on page load: it provisions a Xendit MANAGED
 * sub-account, a KYC entity with no delete endpoint, so an automatic call
 * would permanently provision accounts for creators who never asked.
 *
 * A 409 is NOT a failure here. "already connected" is the answer a creator on a new
 * device needs, and reporting it as an error would send them looking for a problem
 * that does not exist.
 */
export default function AccountPage() {
  const creator = getCreator();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const knownState = useSyncExternalStore(subscribeToAuth, getPaymentAccountState);
  useEffect(() => {
    ensurePaymentAccountStatusLoaded();
  }, []);

  async function connect() {
    setOutcome({ kind: "working" });
    try {
      const result = await apiFetch<{ xenditAccountId: string }>("/payment-account", {
        method: "POST",
      });
      recordPaymentAccountState("connected");
      setOutcome({ kind: "connected", accountId: result.xenditAccountId, alreadyWas: false });
    } catch (err) {
      if (err instanceof DashboardApiError && err.status === 409) {
        const state = paymentAccountStateFromConflict(err.message);
        recordPaymentAccountState(state);
        if (state === "connected") {
          setOutcome({ kind: "connected", accountId: null, alreadyWas: true });
          return;
        }
        if (state === "provisioning") {
          setOutcome({ kind: "in-progress" });
          return;
        }
        // The third 409: the winner released its claim after a provider failure, so
        // trying again really is the right advice. Shown verbatim.
        setOutcome({ kind: "failed", message: err.message });
        return;
      }
      setOutcome({
        kind: "failed",
        message: err instanceof Error ? err.message : "gagal menghubungkan pembayaran",
      });
    }
  }

  return (
    <section className="stack">
      <div>
        <h1>Akun &amp; pembayaran</h1>
      </div>

      <div className="card">
        <h2>Akun Anda</h2>
        {creator !== null ? (
          <p>
            {creator.name}
            {creator.email !== null ? (
              <>
                {" — "}
                <span className="muted">{creator.email}</span>
              </>
            ) : null}
          </p>
        ) : (
          <p className="muted">Tidak ada data akun tersimpan di peramban ini.</p>
        )}
      </div>

      <div className="card stack">
        <div>
          <h2>Pembayaran</h2>
          <p>
            DIUDARA menagih anggota Anda melalui Xendit dan menyetorkan uangnya ke sub-akun Anda
            sendiri. <strong>Sebelum sub-akun itu terhubung, tidak ada yang bisa membeli paket
            Anda</strong> — setiap checkout ditolak dengan pesan “komunitas ini belum siap menerima
            pembayaran”.
          </p>
          <p className="hint">
            Biaya platform DIUDARA dipotong oleh Xendit sebelum uang sampai ke Anda, jadi angka
            pendapatan di dasbor adalah <strong>bruto</strong>, bukan yang Anda terima.
          </p>
        </div>

        {knownState === "connected" && outcome.kind === "idle" ? (
          <p className="form-ok">
            Akun Anda tercatat sudah terhubung. Tekan tombol di bawah kapan pun untuk memastikan.
          </p>
        ) : null}

        {outcome.kind === "connected" ? (
          <p className="form-ok">
            {outcome.alreadyWas
              ? "Pembayaran terhubung: akun pembayaran Anda sudah terhubung sebelumnya."
              : "Pembayaran terhubung. Paket Anda sekarang bisa dibeli."}
            {outcome.accountId !== null ? (
              <>
                {" "}
                ID sub-akun: <code>{outcome.accountId}</code>
              </>
            ) : null}
          </p>
        ) : null}

        {outcome.kind === "in-progress" ? (
          <p className="form-error" role="alert">
            Penghubungan akun pembayaran sedang diproses. Tunggu sebentar lalu coba lagi — jangan
            membuat akun kedua.
          </p>
        ) : null}

        {outcome.kind === "failed" ? (
          <p className="form-error" role="alert">
            Gagal menghubungkan pembayaran: {outcome.message}
          </p>
        ) : null}

        <div>
          <button
            type="button"
            className="button-primary"
            onClick={connect}
            disabled={outcome.kind === "working"}
          >
            {outcome.kind === "working" ? "Menghubungkan..." : "Hubungkan pembayaran"}
          </button>
        </div>
        <p className="hint">
          Aman ditekan berulang kali: jika akun Anda sudah terhubung, tombol ini hanya melaporkan
          bahwa ia sudah terhubung dan tidak membuat akun kedua.
        </p>
      </div>
    </section>
  );
}
