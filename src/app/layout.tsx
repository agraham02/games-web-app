import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { captureInstallPrompt } from "./installCapture";
import { MotionProvider } from "./MotionProvider";
import "./globals.css";

// Served from ./fonts, not fetched from Google at build time: see fonts/README.md.
const cinzel = localFont({
  variable: "--font-cinzel",
  src: "./fonts/cinzel.woff2",
  weight: "400 700",
});

const figtree = localFont({
  variable: "--font-figtree",
  src: "./fonts/figtree.woff2",
  weight: "300 900",
});

// The shell's title face (home, setup, lobby): a light geometric sans. The
// user does not like serifs (2026-10-30); tables keep Cinzel for now.
const jost = localFont({
  variable: "--font-jost",
  src: "./fonts/jost.woff2",
  weight: "100 900",
});

const sourceSerif = localFont({
  variable: "--font-source-serif",
  src: "./fonts/source-serif-4.woff2",
  weight: "400 700",
});

export const metadata: Metadata = {
  title: "Table Games",
  description: "Eight table games — Spades, Dominoes, Poker, Rummy 500, BS, Left Right Center, Chromaly and Mind Meld — with friends in a room, or on your own.",
  // Added to an iPhone's Home Screen, it opens as an app under this name.
  // A black status bar rather than a translucent one: the setup screens'
  // top padding is shorter than the status bar, and would sit under it.
  appleWebApp: { capable: true, title: "Table Games", statusBarStyle: "black" },
};

// The table sizes itself to the visual viewport and paints into the
// safe area, so the browser chrome must not resize the layout.
export const viewport: Viewport = {
  // The shell is near-black; a game route sets its own table colour.
  themeColor: "#050505",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

// An explicit type rather than Next's global `LayoutProps<"/">`. That one is
// GENERATED into `.next/types` by `next dev` / `next build`, so it exists on a
// machine that has ever run either and on no fresh checkout - which made
// `npm run check` fail for anybody who had not, and CI on its first run.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${cinzel.variable} ${figtree.variable} ${jost.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <head>
        {/* Before anything else loads: see installCapture.ts. */}
        <script dangerouslySetInnerHTML={{ __html: `(${captureInstallPrompt.toString()})();` }} />
      </head>
      <body className="min-h-full">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
