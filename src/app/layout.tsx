import type { Metadata, Viewport } from "next";
import { Cinzel, Figtree, Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";
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

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
});

export const metadata: Metadata = {
  title: "Table Games",
  description: "Dominoes, Spades, Rummy 500, Poker and Left Right Center.",
};

// The table sizes itself to the visual viewport and paints into the
// safe area, so the browser chrome must not resize the layout.
export const viewport: Viewport = {
  themeColor: "#071310",
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
      className={`${cinzel.variable} ${figtree.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
