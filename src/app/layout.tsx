import type { Metadata, Viewport } from "next";
import { Cinzel, Figtree, Jost, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
import { captureInstallPrompt } from "./installCapture";
import { MotionProvider } from "./MotionProvider";
import "./globals.css";

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

// The shell's title face (home, setup, lobby): a light geometric sans. The
// user does not like serifs (2026-10-30); tables keep Cinzel for now.
const jost = Jost({
  variable: "--font-jost",
  subsets: ["latin"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
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
