/**
 * "Made by Ahmad Graham", with his site and Instagram: the footer of every
 * screen that is not a game table (home, setup, room entry, the lobby).
 * Rendered by `SetupShell` and the home page, never over a table.
 */

const LINK =
  "underline-offset-4 hover:text-bone-300 hover:underline focus-visible:text-bone-300 focus-visible:underline";

export function Credit() {
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-6 text-xs text-bone-500">
      <span>Made by Ahmad Graham</span>
      <span aria-hidden>·</span>
      <a href="https://www.ahmadgraham.me/" target="_blank" rel="noopener noreferrer" className={LINK}>
        Website
      </a>
      <span aria-hidden>·</span>
      <a href="https://www.instagram.com/ahmad_g02" target="_blank" rel="noopener noreferrer" className={LINK}>
        Instagram
      </a>
    </footer>
  );
}
