import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Two identities on one machine, for testing a ROOM by hand.
   *
   * Identity is a token in `localStorage`, which is per-ORIGIN and not
   * per-tab — so two tabs on `localhost` are one person, and opening a
   * second tab is a second socket for the same seat rather than a second
   * player. `127.0.0.1` is a different origin to `localhost` while being
   * the same server, which is the cheapest way to sit two real players
   * at one table without two browsers or two machines.
   *
   * Dev only, and it has to be declared: Next refuses cross-origin dev
   * requests it was not told about (a plain 403, which shows up as a
   * table stuck on "Connecting…"). `npm start` never consults this.
   */
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
