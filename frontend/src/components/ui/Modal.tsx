import { useEffect, useId, useRef, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark } from "@fortawesome/free-solid-svg-icons";

type Props = {
  title: string;
  /** Optional line under the title. */
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned below the scrolling body — buttons stay reachable in a long modal. */
  footer?: ReactNode;
  width?: number;
  /** Set false for a modal whose work must not be lost to a stray backdrop click. */
  closeOnBackdrop?: boolean;
};

/**
 * The app's one modal. Every dialog goes through this so the behaviour people
 * expect — Escape closes it, the page behind does not scroll, focus starts and
 * stays inside — is implemented once instead of per dialog.
 */
export default function Modal({
  title, subtitle, onClose, children, footer, width = 520, closeOnBackdrop = true,
}: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Captured on mount so focus goes back to whatever opened the modal.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;

    // Focus the first control, else the dialog itself, so screen readers and
    // the keyboard both land inside rather than behind the overlay.
    const dialog = dialogRef.current;
    const firstControl = dialog?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([data-modal-close]), [href], [tabindex]:not([tabindex="-1"])',
    );
    (firstControl ?? dialog)?.focus();

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;

      // Trap Tab: without this, tabbing walks into the page behind the overlay,
      // where clicks are blocked and the user appears stuck.
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = overflow;
      openerRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => {
        // mousedown, not click: a drag that starts inside and ends on the
        // backdrop (selecting text, say) should not close the modal.
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed", inset: 0, background: "rgba(22,40,58,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 200, padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="card"
        style={{
          width, maxWidth: "100%", maxHeight: "88vh",
          display: "flex", flexDirection: "column", outline: "none",
        }}
      >
        <div
          style={{
            display: "flex", justifyContent: "space-between", alignItems: "flex-start",
            gap: 12, padding: "20px 24px 14px",
          }}
        >
          <div>
            <h3 id={titleId} style={{ fontSize: 16, fontWeight: 700 }}>{title}</h3>
            {subtitle && (
              <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 3 }}>{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            data-modal-close
            aria-label="Tutup"
            onClick={onClose}
            className="btn btn-ghost btn-icon"
            style={{ width: 28, height: 28, fontSize: 12, flexShrink: 0 }}
          >
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </div>

        <div style={{ padding: "0 24px", overflowY: "auto", flex: 1, minHeight: 0 }}>
          {children}
        </div>

        {footer && (
          <div style={{ padding: "14px 24px 20px", borderTop: "1px solid var(--ink-150)", marginTop: 14 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
