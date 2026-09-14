import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The first modal/overlay in this app — everything before it (`DeleteConfirm`
 * in `postOwnerActions.tsx`) is an inline confirmation panel in normal
 * document flow, not a true backdrop+portal overlay. Kept deliberately
 * minimal: a portal to `document.body` so it never inherits an ancestor's
 * `overflow`/`transform`, a backdrop that closes on click, `Escape` closes,
 * and the panel is focused on mount so a keyboard/screen-reader user lands
 * inside it rather than on whatever was behind it.
 *
 * No focus TRAP — Escape and the backdrop are both always reachable ways
 * out, and this app has exactly one modal consumer (`CoBuilderModal`) whose
 * content is a short chat form, not a workflow deep enough to make an
 * accidental Tab-out costly. Add one if a second consumer needs it.
 */
export default function Modal({
  onClose,
  labelledBy,
  children,
}: {
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        // Stops a click INSIDE the panel from bubbling to the backdrop and
        // closing the modal out from under whatever was just tapped.
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
