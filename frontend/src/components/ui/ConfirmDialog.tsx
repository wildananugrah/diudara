import type { ReactNode } from "react";
import Modal from "./Modal";

type Props = {
  title: string;
  /** Secondary line under the title — usually who made the thing, and when. */
  subtitle?: string;
  /** What the user is about to lose. Kept as children so each caller can be specific. */
  children: ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  busy?: boolean;
  /** "danger" for destructive actions (the default); "primary" for a plain confirm. */
  tone?: "danger" | "primary";
  /** Disables the confirm button — e.g. a rename with an empty field. */
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * The app's destructive-action confirm. Every "are you sure?" goes through this
 * so the same guarantees hold everywhere: the backdrop cannot dismiss it, the
 * buttons lock while the request is in flight, and the danger action is styled
 * as one rather than looking like an ordinary button.
 */
export default function ConfirmDialog({
  title, subtitle, children,
  confirmLabel = "Ya, hapus", busyLabel = "Menghapus…",
  busy = false, tone = "danger", disabled = false, onConfirm, onCancel,
}: Props) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      // Mid-request the dialog stays put: closing it would hide an action the
      // user cannot tell the outcome of.
      onClose={() => (busy ? undefined : onCancel())}
      closeOnBackdrop={false}
      width={440}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Batal</button>
          <button
            className={`btn btn-sm ${tone === "danger" ? "btn-danger" : "btn-primary"}`}
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      }
    >
      {children}
    </Modal>
  );
}
