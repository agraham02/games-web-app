import type { MetadataRoute } from "next";

/**
 * What makes the site installable as an app: served at
 * `/manifest.webmanifest` and linked from every page by Next.
 *
 * Chromium needs a name, a 192px and a 512px icon, `start_url` and a
 * `display`; the maskable icon is what Android cuts into its own shape.
 * Opens full screen at the home page, on the felt's own colour. The icons
 * come from `scripts/app-icons.ts`. See `InstallPrompt` for the home page's
 * invitation to install.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Table Games",
    short_name: "Table Games",
    description: "Dominoes, Spades, Rummy 500, Poker, Left Right Center and BS — with friends in a room, or on your own.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#071310",
    theme_color: "#071310",
    categories: ["games"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
