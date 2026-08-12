"use client";

/**
 * Chrome for the lab routes: navigation, a device frame, and the small
 * control widgets the harness pages share.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import type { Density } from "@/table/geometry";

const ROUTES = [
  { href: "/lab/seats", label: "Seats" },
  { href: "/lab/motion", label: "Motion" },
  { href: "/lab/tokens", label: "Tokens" },
  { href: "/lab/phases", label: "Phases" },
  { href: "/lab/rummy", label: "Rummy" },
];

export function LabNav() {
  const path = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-brass-600/25 bg-felt-950/80 px-3 py-2 backdrop-blur">
      <Link
        href="/"
        className="mr-2 font-display text-[13px] tracking-widest text-brass-300"
      >
        LAB
      </Link>
      {ROUTES.map((r) => (
        <Link
          key={r.href}
          href={r.href}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
            path === r.href
              ? "bg-brass-400 text-felt-950"
              : "text-bone-400 hover:bg-bone-50/8 hover:text-bone-50"
          }`}
        >
          {r.label}
        </Link>
      ))}
    </nav>
  );
}

/* ============================================================
   Device frames — the review gate for "does it work on a phone".
   ============================================================ */

export const DEVICES = {
  phone: { label: "Phone", w: 390, h: 844, density: "compact" as Density },
  phoneLandscape: { label: "Phone ↻", w: 844, h: 390, density: "regular" as Density },
  tablet: { label: "Tablet", w: 768, h: 1024, density: "regular" as Density },
  desktop: { label: "Desktop", w: 1280, h: 800, density: "wide" as Density },
} as const;

export type DeviceKey = keyof typeof DEVICES;

export function DeviceFrame({
  device,
  children,
}: {
  device: DeviceKey;
  children: React.ReactNode;
}) {
  const d = DEVICES[device];
  const rounded = device.startsWith("phone") ? "rounded-[34px]" : "rounded-2xl";

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <div
        className={`relative shrink-0 overflow-hidden ring-1 ring-brass-400/25 shadow-[0_24px_64px_rgb(0_0_0/0.55)] ${rounded}`}
        style={{ width: d.w, height: d.h }}
      >
        {children}
      </div>
    </div>
  );
}

/* ============================================================
   Controls
   ============================================================ */

export function Control({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  // Not a <label>: that element is only well-defined for a single native
  // form control. Several Controls here wrap a row of sibling <button>s
  // (SegButton, the Fire Events group), and a <label> around multiple
  // interactive children makes browsers compute a garbled accessible
  // name for each one (confirmed: it silently swallows the label text
  // of whichever button happens to be first). `role="group"` +
  // `aria-labelledby` labels the group correctly either way — one
  // slider or many buttons — without that ambiguity.
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1.5">
      <span id={id} className="eyebrow">
        {label}
      </span>
      {children}
    </div>
  );
}

export function SegButton<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            value === o.value
              ? "bg-brass-400 text-felt-950"
              : "bg-bone-50/6 text-bone-200 ring-1 ring-bone-50/12 hover:bg-bone-50/12"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function LabButton({
  children,
  onClick,
  tone = "ghost",
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  tone?: "primary" | "ghost";
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-2 text-xs font-bold transition-opacity disabled:opacity-40 ${
        tone === "primary"
          ? "bg-linear-to-b from-brass-300 to-brass-500 text-felt-950 shadow-e2"
          : "bg-bone-50/6 text-bone-200 ring-1 ring-bone-50/16 hover:bg-bone-50/12"
      }`}
    >
      {children}
    </button>
  );
}

export function LabPanel({ children }: { children: React.ReactNode }) {
  return (
    <aside className="w-full shrink-0 space-y-4 border-b border-brass-600/20 bg-felt-900/60 p-4 lg:w-72 lg:border-r lg:border-b-0">
      {children}
    </aside>
  );
}
