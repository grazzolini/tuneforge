import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  PlaybackPracticeRail,
  type PlaybackPracticeRailHandle,
} from "./PlaybackPracticeRail";

const HISTORY_KEY = "tuneforgePracticeControls";
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function PlaybackPracticeControlsDrawer({
  onDismiss,
  open,
}: {
  onDismiss: () => void;
  open: boolean;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const practiceRailRef = useRef<PlaybackPracticeRailHandle>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const historyMarkerRef = useRef(`practice-controls-${crypto.randomUUID()}`);

  useEffect(() => {
    if (!open) {
      return;
    }

    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const marker = historyMarkerRef.current;
    window.history.pushState(
      { ...window.history.state, [HISTORY_KEY]: marker },
      "",
      window.location.href,
    );
    closeButtonRef.current?.focus();

    const dismissFromUi = () => {
      practiceRailRef.current?.flushPendingTempo();
      onDismiss();
      if (window.history.state?.[HISTORY_KEY] === marker) {
        window.history.back();
      }
    };
    const handlePopState = () => {
      practiceRailRef.current?.flushPendingTempo();
      onDismiss();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissFromUi();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("popstate", handlePopState);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("keydown", handleKeyDown);
      const restoreTarget = restoreFocusRef.current;
      window.setTimeout(() => restoreTarget?.focus(), 0);
    };
  }, [onDismiss, open]);

  if (!open) {
    return null;
  }

  const marker = historyMarkerRef.current;
  const dismissFromUi = () => {
    practiceRailRef.current?.flushPendingTempo();
    onDismiss();
    if (window.history.state?.[HISTORY_KEY] === marker) {
      window.history.back();
    }
  };

  return createPortal(
    <div className="mobile-practice-controls-layer" data-mobile-practice-controls="open">
      <div
        aria-hidden="true"
        className="mobile-practice-controls__scrim"
        onClick={dismissFromUi}
      />
      <section
        aria-labelledby="mobile-practice-controls-title"
        aria-modal="true"
        className="mobile-practice-controls"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="mobile-practice-controls__header">
          <div>
            <p className="metric-label">Playback</p>
            <h2 id="mobile-practice-controls-title">Practice Controls</h2>
          </div>
          <button
            aria-label="Close Practice Controls"
            className="button button--ghost button--small mobile-practice-controls__close"
            onClick={dismissFromUi}
            ref={closeButtonRef}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
        <PlaybackPracticeRail ref={practiceRailRef} variant="drawer" />
      </section>
    </div>,
    document.body,
  );
}
