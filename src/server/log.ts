/**
 * Correlated structured logs.
 *
 * The reason this is not `console.log` with a nice message: with a dozen
 * sockets attached to three rooms, the interesting failures are all
 * interleavings — a leader disconnecting while somebody else is mid-turn,
 * two clients racing the same seat — and a stream of prose lines gives you
 * no way to pull one room's story out of the noise. Every line carries the
 * room code and a short session id so a failure can be traced across
 * concurrent connections without diffing terminals by eye.
 *
 * Sessions are logged as an 8-character prefix, never in full, and tokens
 * are never logged at all. A token in a log file is a credential in a log
 * file: anyone holding it can reclaim that player's seat, hand and score.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  room?: string;
  session?: string;
  event?: string;
  seq?: number;
  seat?: number | null;
  error?: string;
  [key: string]: unknown;
}

/** Quiet by default in tests, which would otherwise drown in room chatter. */
let threshold: LogLevel = process.env.NODE_ENV === "test" ? "error" : "info";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Never the whole thing — see the header. */
export function shortId(session: string): string {
  return session.slice(0, 8);
}

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  if (typeof line.session === "string") line.session = shortId(line.session);
  // One JSON object per line: greppable by room, and parseable by anything
  // that reads logs for a living.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
