"use client";

/**
 * The button — the only one.
 *
 * Until multiplayer there were about fifteen of these, each a copy-pasted
 * Tailwind class string, and that was tolerable because every one of them
 * lived on a setup screen a person saw once per game. A lobby has a dozen
 * on screen at once, and the table grew its own (`ActionButton` twice,
 * `BarButton`, the phase screens' pair, six "Deal in"s) — one look each,
 * one focus state each (none), one set of bugs each.
 *
 * The three tones are the three jobs the app actually has: brass gradient
 * for the one thing a screen is FOR, a ghost for everything else, and a
 * red-tinted ghost for the ones you cannot take back. `shape="pill"` is the
 * table's action buttons, which sit over felt rather than in a panel.
 *
 * Variants are `cva`, the shadcn convention, so a combination that does
 * not exist is a type error rather than a string nobody styled.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors duration-(--duration-ui) outline-none",
    // A designed focus ring, drawn outside the button so it never sits on
    // top of the ghost tone's own hairline ring.
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    // Dimmed and still there, per the disclosure policy's "dim, don't
    // hide": a control that vanishes when unavailable makes the layout
    // jump and teaches nobody why it went.
    "disabled:cursor-not-allowed disabled:opacity-40",
    "[&_svg]:shrink-0",
  ],
  {
    variants: {
      tone: {
        primary:
          "bg-linear-to-b from-brass-300 to-brass-500 font-extrabold text-felt-950 shadow-e2 hover:from-brass-200 hover:to-brass-400",
        ghost:
          "bg-bone-50/6 font-semibold text-bone-200 ring-1 ring-bone-50/16 hover:bg-bone-50/12 hover:text-bone-50",
        // Tinted rather than filled: a destructive action should be findable
        // without shouting over the primary one it usually sits beside.
        danger: "bg-loss/18 font-semibold text-bone-100 ring-1 ring-loss hover:bg-loss/28",
      },
      size: {
        xs: "rounded-lg px-3 py-2 text-xs",
        sm: "rounded-md px-3 py-1.5 text-xs",
        md: "rounded-lg px-6 py-3.5 text-sm",
        lg: "rounded-lg px-6 py-4 text-base",
      },
      shape: {
        rounded: "",
        pill: "rounded-full px-6 py-2.5 text-sm",
      },
    },
    defaultVariants: { tone: "ghost", size: "md", shape: "rounded" },
  },
);

export type ButtonTone = NonNullable<VariantProps<typeof buttonVariants>["tone"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ tone, size, shape, className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      data-slot="button"
      className={cn(buttonVariants({ tone, size, shape }), className)}
      {...rest}
    >
      {children}
    </button>
  );
}
