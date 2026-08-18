import type { Metadata, Viewport } from "next";
import { Cinzel, Figtree, Source_Serif_4 } from "next/font/google";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
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
