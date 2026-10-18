// Selection primitives shared by the deploy flow (DESIGN.md §7 "Selection cards").

/**
 * Classes for a selectable card. Selection is shown by accent border + ring +
 * tinted background (the ring keeps the border width constant, so nothing shifts).
 */
export function selectCardClass(selected: boolean): string {
  return `rounded-xl border p-4 text-left cursor-pointer transition-[border-color,background-color,box-shadow] duration-200 ease-out ${
    selected
      ? "border-primary bg-primary/10 ring-1 ring-primary"
      : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
  }`;
}

/** Radio indicator for selection cards; the card itself carries role="radio". Filled with the accent when checked. */
export function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      className={`size-4.5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors duration-200 ${
        checked ? "border-primary bg-primary" : "border-line-strong bg-canvas"
      }`}
      aria-hidden
    >
      <span
        className={`size-1.5 rounded-full bg-on-primary transition-transform duration-200 ${checked ? "scale-100" : "scale-0"}`}
      />
    </span>
  );
}

/** Visual switch track; the surrounding button carries role="switch". */
export function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={`w-10 h-6 rounded-full p-0.5 shrink-0 border transition-colors duration-200 ease-out ${
        on ? "bg-primary border-primary" : "bg-surface-2 border-line-strong"
      }`}
      aria-hidden
    >
      <span
        className={`block size-4.5 rounded-full bg-on-primary shadow-sm transition-transform duration-200 ease-out ${
          on ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </span>
  );
}

/** Green "Save N%" pill. */
export function SavePill({ percent, className = "" }: { percent: number; className?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border border-success/30 bg-success/15 px-2 py-0.5 text-xs font-semibold text-success ${className}`}
    >
      Save {percent}%
    </span>
  );
}
