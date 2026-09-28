import { useEffect, useRef } from "react";

function focusables(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )).filter((el) => el.offsetParent !== null);
}

/** Keeps Tab focus inside the returned ref's element while `active`, moves focus into it (or
 *  back to its first control whenever `resetKey` changes — e.g. a stacked panel swapping its
 *  content), and returns focus to whatever was focused before the dialog opened once it closes.
 *  Attach the ref to the dialog's outermost element and give that element `tabIndex={-1}` so it
 *  has somewhere to land if it contains no focusable controls of its own. */
export function useFocusTrap<T extends HTMLElement>(active: boolean, resetKey: unknown = null) {
  const ref = useRef<T>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => { previouslyFocused.current?.focus?.(); };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const first = focusables(ref.current)[0] ?? ref.current;
    first?.focus();
  }, [active, resetKey]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(ref.current);
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  return ref;
}
