import type { Viewport } from "next";
import { GAME_THEMES } from "@/ui/gameTheme";

// The browser's address bar takes the table's colour: the page itself is a
// client component and cannot export `viewport`.
export const viewport: Viewport = { themeColor: GAME_THEMES.dominoes.deep };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
