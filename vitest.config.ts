import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // No @vitejs/plugin-react here: Next 16 pulls a rolldown-based Vite
  // while Vitest bundles its own, and the plugin's types conflict across
  // the two. Tests need the JSX transform, not Fast Refresh, so esbuild's
  // automatic runtime covers it.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
