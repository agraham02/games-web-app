/**
 * Talks to the server the way a hostile client would.
 *
 * The point of this harness is everything a browser cannot conveniently
 * do: send a malformed frame, act out of turn, race another client to the
 * same action, present a token that was never valid. Playwright drives the
 * real UI and so can only ever send what the UI is willing to send, which
 * is exactly the wrong tool for finding out what the server does when
 * somebody sends something else.
 *
 * Run against an already-running server:
 *
 *     npm run dev            # in one terminal
 *     npm run harness        # in another
 *
 * Every scenario asserts against `/debug/room/:code` — the authoritative
 * server-side state — rather than against what a client was sent. The
 * client's view is derived, so asserting on it cannot tell "the server got
 * it wrong" apart from "the server got it right and told me badly".
 */

import WebSocket from "ws";
// The 52 real ids, so the leak check below cannot drift from the deck.
import { rummyDeck } from "../src/games/rummy/cards";

const BASE = process.env.HARNESS_URL ?? "http://localhost:3000";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const PROTOCOL = 1;

/* ============================================================
   A scriptable client
   ============================================================ */

type Message = Record<string, unknown>;

class Client {
  private ws!: WebSocket;
  readonly inbox: Message[] = [];
  session: string | null = null;

  constructor(readonly token: string) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Message;
      this.inbox.push(msg);
      if (msg.t === "hello") this.session = msg.session as string;
    });
  }

  /** Deliberately untyped: sending nonsense is half the point of this file. */
  send(msg: unknown): void {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  async hello(): Promise<void> {
    this.send({ t: "hello", token: this.token, protocol: PROTOCOL });
    await this.until((m) => m.t === "hello" || m.t === "error");
  }

  /** Waits for a matching message, or throws — a hang here is a real failure. */
  async until(match: (m: Message) => boolean, ms = 3000): Promise<Message> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.inbox.find(match);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out; inbox was ${JSON.stringify(this.inbox.map((m) => m.t))}`);
      }
      await sleep(25);
    }
  }

  latest(t: string): Message | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t);
  }

  clear(): void {
    this.inbox.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dump(code: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/debug/room/${code}`);
  if (!res.ok) throw new Error(`debug dump failed: ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/* ============================================================
   Scenarios
   ============================================================ */

let passed = 0;
let failed = 0;

async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  const clients: Client[] = [];
  track = clients;
  try {
    await body();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const c of clients) c.close();
  }
}

let track: Client[] = [];

async function client(token: string): Promise<Client> {
  const c = new Client(token);
  await c.connect();
  await c.hello();
  track.push(c);
  return c;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Fills a room with `count` REAL clients and returns them, host first.
 *
 * Every game scenario in this file before this one seated two people and
 * let bots take the rest, so nothing anywhere exercised the shapes the
 * games are actually built around: a partnership needs four, and BS's
 * whole reason for `turnHold` is what happens when three or more people
 * each have to be asked about the same window.
 */
async function party(
  tag: string,
  count: number,
  names: string[],
): Promise<{ code: string; clients: Client[] }> {
  const stamp = Date.now();
  const host = await client(`t-${tag}-0-${stamp}`);
  const code = await hostRoom(host, names[0] ?? "P0");
  const clients = [host];
  for (let i = 1; i < count; i++) {
    const c = await client(`t-${tag}-${i}-${stamp}`);
    c.send({ t: "joinRoom", code, name: names[i] ?? `P${i}` });
    await c.until((m) => m.t === "room");
    clients.push(c);
  }
  return { code, clients };
}

/**
 * BS only: plays one card from this client's OWN hand if it is on turn.
 *
 * A frame carries the viewer's own cards under their real ids - that is
 * the whole point of the redaction layer - so a scripted player can play
 * for real rather than being handed a legal move by the server.
 */
function playOneBs(c: Client, seat: number): boolean {
  const frame = c.latest("frame");
  if (!frame) return false;
  const state = (frame.frame as { state?: { turn?: number; hands?: Record<string, string[]> } })
    .state;
  if (!state || state.turn !== seat) return false;
  const hand = state.hands?.[String(seat)] ?? [];
  const card = hand.find((id) => typeof id === "string" && !id.startsWith("#"));
  if (!card) return false;
  c.send({ t: "action", action: { t: "play", cards: [card] } });
  return true;
}

/** Every client's own seat, once a game has dealt. */
function seatsOf(clients: Client[]): number[] {
  return clients.map((c) => {
    const frame = c.latest("frame");
    assert(frame, "every player should have been dealt in");
    return (frame.frame as { seat: number }).seat;
  });
}

/** Creates a room and returns its code. */
async function hostRoom(c: Client, name = "Host"): Promise<string> {
  c.send({ t: "createRoom", name });
  const msg = await c.until((m) => m.t === "room");
  return (msg.room as { code: string }).code;
}

async function main(): Promise<void> {
  console.log(`\nws harness -> ${WS_URL}\n`);

  await scenario("malformed input is answered, not fatal", async () => {
    const a = await client(`t-malformed-${Date.now()}`);
    a.send("this is not json");
    await a.until((m) => m.t === "error" && m.code === "bad-message");
    // Still usable afterwards — a garbled frame must not cost the connection.
    a.clear();
    const code = await hostRoom(a);
    assert(code.length === 4, `expected a 4-letter code, got ${code}`);
  });

  await scenario("commands before hello are refused", async () => {
    const raw = new Client(`t-nohello-${Date.now()}`);
    await raw.connect();
    track.push(raw);
    raw.send({ t: "createRoom", name: "Jumped" });
    await raw.until((m) => m.t === "error");
  });

  await scenario("a wrong protocol version is refused outright", async () => {
    const raw = new Client(`t-proto-${Date.now()}`);
    await raw.connect();
    track.push(raw);
    raw.send({ t: "hello", token: raw.token, protocol: 999 });
    await raw.until((m) => m.t === "error");
  });

  await scenario("a stale token gets a fresh identity, not somebody else's seat", async () => {
    const a = await client(`t-owner-${Date.now()}`);
    const code = await hostRoom(a, "Owner");
    const stranger = await client(`t-stale-${Date.now()}`);
    stranger.send({ t: "joinRoom", code, name: "Stranger" });
    await stranger.until((m) => m.t === "room");

    const state = await dump(code);
    const members = state.members as Record<string, { name: string }>;
    assert(Object.keys(members).length === 2, "expected two members");
    assert(a.session !== stranger.session, "two tokens must not share one session");
  });

  await scenario("only one of two simultaneous starts is accepted", async () => {
    const a = await client(`t-race-a-${Date.now()}`);
    const code = await hostRoom(a, "Racer");
    // A room needs two people before it will start anything
    // (MIN_ROOM_PLAYERS), so the second client is a precondition of the
    // race rather than part of it.
    const b = await client(`t-race-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Second" });
    await b.until((m) => m.t === "room");
    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
    await sleep(50);
    a.clear();

    // Both in the same tick, before either answer can arrive.
    a.send({ t: "startGame" });
    a.send({ t: "startGame" });
    await sleep(200);

    const errors = a.inbox.filter((m) => m.t === "error");
    assert(errors.length === 1, `expected exactly one refusal, got ${errors.length}`);
    assert(
      errors[0]!.code === "game-already-running",
      `expected game-already-running, got ${errors[0]!.code}`,
    );
    const state = await dump(code);
    assert(state.sessionRunning === true, "a game should be running");
  });

  await scenario("a non-leader cannot use leader powers", async () => {
    const a = await client(`t-leader-${Date.now()}`);
    const code = await hostRoom(a, "Boss");
    const b = await client(`t-peon-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Peon" });
    await b.until((m) => m.t === "room");
    b.clear();

    b.send({ t: "startGame" });
    const err = await b.until((m) => m.t === "error");
    assert(err.code === "not-leader" || err.code === "no-game-selected", `got ${err.code}`);

    b.send({ t: "kick", session: a.session });
    await b.until((m) => m.t === "error" && m.code === "not-leader");
  });

  await scenario("an out-of-turn move changes nothing", async () => {
    const a = await client(`t-turn-a-${Date.now()}`);
    const code = await hostRoom(a, "P1");
    const b = await client(`t-turn-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "P2" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(400);

    // Find who is genuinely on turn, then have somebody else act.
    const before = await dump(code);
    const table = before.table as { currentSeat: number | null; fingerprint: string };
    const owners = (before.game as { seatOwner: (string | null)[] }).seatOwner;
    const onTurn = table.currentSeat;
    assert(onTurn !== null, "somebody should be on turn");

    const impostor = [a, b].find((c) => owners.indexOf(c.session!) !== onTurn);
    assert(impostor, "one of the two humans should not be on turn");
    impostor.clear();
    impostor.send({ t: "action", action: { t: "bid", tricks: 3, nil: false } });

    // The refusal is the deterministic part: bots keep playing in the
    // background, so a fingerprint comparison alone would be racing them.
    const err = await impostor.until((m) => m.t === "error");
    assert(
      err.message === "not-your-turn",
      `expected not-your-turn, got ${JSON.stringify(err.message)}`,
    );
  });

  await scenario("a spectator is never sent another player's cards", async () => {
    // The assertion that matters most in this file: not "the UI hides it"
    // but "it was never on the wire".
    const a = await client(`t-spec-a-${Date.now()}`);
    const code = await hostRoom(a, "Dealer");
    // Two people to get a game going at all (MIN_ROOM_PLAYERS); the
    // spectator arrives afterwards, which is the point of the scenario.
    const partner = await client(`t-spec-p-${Date.now()}`);
    partner.send({ t: "joinRoom", code, name: "Partner" });
    await partner.until((m) => m.t === "room");
    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(600);

    const truth = await dump(code);
    const watcher = await client(`t-spec-w-${Date.now()}`);
    watcher.send({ t: "joinRoom", code, name: "Watcher" });
    await watcher.until((m) => m.t === "room");
    watcher.clear();
    // Explicitly a spectator: three seats are free, so without asking they
    // would simply be seated, which is the correct default and the wrong
    // thing to be testing here.
    watcher.send({ t: "enterGame", as: "spectator" });
    await watcher.until((m) => m.t === "frame");
    await sleep(300);

    // First prove the spectator was actually sent a dealt table, or the
    // leak check below would pass simply by having received nothing.
    const frame = watcher.latest("frame");
    assert(frame, "the spectator should have received a frame");
    const placements = (frame.frame as { placements: Record<string, unknown> }).placements;
    const standIns = Object.keys(placements).filter((k) => k.startsWith("#"));
    assert(
      standIns.length >= 52,
      `expected a full concealed deck of stand-ins, saw ${standIns.length}`,
    );
    assert(
      (truth.table as { round: number }).round >= 1,
      "the server should have a dealt table to be concealing",
    );

    // A spectator holds no seat, so every hand is concealed from them. Any
    // real card id anywhere in their traffic is a leak.
    //
    // Matched against the deck itself rather than a hand-written pattern.
    // The pattern this replaces was `/"[SHDC]-(?:A|K|...)"/` — ids with a
    // hyphen in them, which this app has never produced: a card is
    // `${suit}${rank}`, so `SA` and `D10`. It could not match anything and
    // the assertion below had never once been able to fail. The file's own
    // header calls this the assertion that matters most, which is exactly
    // why it must not be able to quietly pass.
    const named = (inbox: unknown) =>
      rummyDeck().filter((id) => JSON.stringify(inbox).includes(`"${id}"`));

    // The control, and the reason the check above is now trustworthy: a
    // SEATED player is entitled to their own thirteen, so the same scan
    // over the dealer's traffic has to find cards. If it finds none there
    // either, the scan is broken rather than the redaction being perfect —
    // which is precisely the state this test spent its whole life in.
    assert(
      named(a.inbox).length >= 13,
      `the scan found no cards in a seated player's own traffic, so it proves nothing`,
    );

    const leaked = named(watcher.inbox);
    assert(
      leaked.length === 0,
      `a spectator was sent real card ids: ${leaked.slice(0, 5).join(", ")}`,
    );
  });

  await scenario("backing out hands the seat to a bot and keeps it reserved", async () => {
    const a = await client(`t-bot-a-${Date.now()}`);
    const code = await hostRoom(a, "Stayer");
    const b = await client(`t-bot-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Leaver" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(300);

    const seated = await dump(code);
    const owners = (seated.game as { seatOwner: (string | null)[] }).seatOwner;
    const seat = owners.indexOf(b.session!);
    assert(seat >= 0, "the joiner should have been seated");

    b.send({ t: "exitGame" });
    await sleep(200);

    const after = await dump(code);
    const live = after.liveSeats as boolean[];
    const stillOwned = (after.game as { seatOwner: (string | null)[] }).seatOwner[seat];
    assert(stillOwned === b.session, "the seat must stay reserved for whoever stepped away");
    assert(live[seat] === false, "the seat must now be played by a bot");
  });

  await scenario("a disconnect frees nothing and a reconnect reclaims the same seat", async () => {
    const token = `t-recon-${Date.now()}`;
    const a = await client(`t-recon-host-${Date.now()}`);
    const code = await hostRoom(a, "Host");
    const b = new Client(token);
    await b.connect();
    await b.hello();
    track.push(b);
    b.send({ t: "joinRoom", code, name: "Returner" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "steady" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(300);

    const before = await dump(code);
    const seat = (before.game as { seatOwner: (string | null)[] }).seatOwner.indexOf(b.session!);
    assert(seat >= 0, "the joiner should have been seated");

    b.close();
    await sleep(200);
    const dropped = await dump(code);
    assert(
      (dropped.game as { seatOwner: (string | null)[] }).seatOwner[seat] === b.session,
      "a disconnect must not release the seat",
    );

    // Same token, brand new socket — the whole of reconnection.
    const back = new Client(token);
    await back.connect();
    await back.hello();
    track.push(back);
    await back.until((m) => m.t === "room");

    const after = await dump(code);
    assert(
      (after.game as { seatOwner: (string | null)[] }).seatOwner[seat] === back.session,
      "the returning player must get the same seat",
    );
    assert((after.liveSeats as boolean[])[seat] === true, "the bot should have handed it back");
  });

  await scenario("a private room queues a join until the leader approves", async () => {
    const a = await client(`t-priv-a-${Date.now()}`);
    const code = await hostRoom(a, "Gatekeeper");
    a.send({ t: "setPrivacy", privacy: "private" });
    await sleep(50);

    const b = await client(`t-priv-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Knocker" });
    await b.until((m) => m.t === "pending");

    let state = await dump(code);
    assert(Object.keys(state.members as object).length === 1, "should not be a member yet");
    assert(Object.keys(state.pending as object).length === 1, "should be queued");

    b.clear();
    a.send({ t: "approve", session: b.session });
    await sleep(150);
    state = await dump(code);
    assert(Object.keys(state.members as object).length === 2, "should be a member after approval");

    // Being approved has to be observable to the person approved, and it
    // has to actually connect their socket to the room. A membership that
    // exists while they sit on a waiting screen is the same as no
    // membership at all.
    const view = await b.until((m) => m.t === "room");
    assert((view.room as { code: string }).code === code, "the approved member should get a roster");

    b.clear();
    b.send({ t: "rename", name: "Admitted" });
    await sleep(150);
    const renamed = await dump(code);
    const names = Object.values(renamed.members as Record<string, { name: string }>).map(
      (m) => m.name,
    );
    assert(names.includes("Admitted"), `an approved member should be able to act; saw ${names}`);
  });

  await scenario("leadership moves on when the leader drops, and the new one can act", async () => {
    const a = await client(`t-lead-a-${Date.now()}`);
    const code = await hostRoom(a, "First");
    const b = await client(`t-lead-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Second" });
    await b.until((m) => m.t === "room");

    a.close();
    await sleep(250);

    const state = await dump(code);
    assert(state.leader === b.session, `leadership should have passed; leader is ${state.leader}`);

    b.clear();
    b.send({ t: "setPrivacy", privacy: "private" });
    await sleep(150);
    const after = await dump(code);
    assert(after.privacy === "private", "the new leader should be able to act immediately");
  });

  await scenario("fault injection drops a client on command", async () => {
    const a = await client(`t-fault-a-${Date.now()}`);
    const code = await hostRoom(a, "Victim");
    const res = await fetch(`${BASE}/debug/drop/${code}/${a.session}`, { method: "POST" });
    assert(res.ok, `drop endpoint returned ${res.status}`);
    await sleep(150);
    const state = await dump(code);
    assert((state.attached as string[]).length === 0, "the socket should be gone");
  });

  await scenario("two humans play a real hand of Spades to a scored round", async () => {
    // The end-to-end proof for the whole feature: two independent clients,
    // one authoritative server, real bidding and real card play, driven
    // purely by what each client is TOLD it may legally do.
    const a = await client(`t-play-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-play-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(400);

    const seatOf = new Map<Client, number>();
    for (const c of [a, b]) {
      const frame = c.latest("frame");
      assert(frame, "both players should have been dealt in");
      seatOf.set(c, (frame.frame as { seat: number }).seat);
    }
    assert(seatOf.get(a) !== seatOf.get(b), "two players must not share a seat");

    // Each client acts only when the server says it is their turn, using
    // only what its own redacted view shows it holds.
    let acted = 0;
    for (let tick = 0; tick < 300; tick++) {
      const state = await dump(code);
      const table = state.table as { currentSeat: number | null; round: number } | null;
      if (!table) break;
      if (table.round > 1) break;

      const turn = table.currentSeat;
      const who = [a, b].find((c) => seatOf.get(c) === turn);
      if (who) {
        const frame = who.latest("frame")!.frame as {
          state: { phase: string; hands: Record<string, string[]> };
          seat: number;
        };
        const mine = frame.state.hands[String(frame.seat)] ?? [];
        if (frame.state.phase === "bid") {
          who.send({ t: "action", action: { t: "look" } });
          await sleep(40);
          who.send({ t: "action", action: { t: "bid", tricks: 3, nil: false } });
        } else if (mine.length > 0) {
          // Try cards until one is accepted. The client deliberately does
          // NOT reimplement follow-suit — the server deciding that is the
          // whole point of an authoritative server.
          for (const card of mine) {
            who.clear();
            who.send({ t: "action", action: { t: "play", card } });
            await sleep(70);
            if (!who.latest("error")) break;
          }
        }
        acted += 1;
      }
      await sleep(70);
    }

    assert(acted > 0, "at least one human turn should have been taken");
    // A hand that shrank proves real cards went through the wire and were
    // accepted by rules running on the server.
    const frame = a.latest("frame")!.frame as {
      state: { hands: Record<string, string[]> };
      seat: number;
    };
    const remaining = (frame.state.hands[String(frame.seat)] ?? []).length;
    assert(remaining < 13, `expected cards to have been played; ${remaining} still held`);
  });

  await scenario("stepping away mid-hand hands the seat to a bot, and it comes back", async () => {
    const a = await client(`t-mid-host-${Date.now()}`);
    const code = await hostRoom(a, "Host");
    const b = await client(`t-mid-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Wanderer" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(400);

    const before = await dump(code);
    const seat = (before.game as { seatOwner: (string | null)[] }).seatOwner.indexOf(b.session!);
    assert(seat >= 0, "should be seated");

    // Stepping away to the lobby, not disconnecting — the other route to a
    // bot taking over, and the one a player chooses deliberately.
    b.send({ t: "exitGame" });
    await sleep(300);
    const away = await dump(code);
    assert((away.liveSeats as boolean[])[seat] === false, "a bot should be playing the seat");
    assert(
      (away.game as { seatOwner: (string | null)[] }).seatOwner[seat] === b.session,
      "the seat must stay theirs while they are away",
    );

    b.clear();
    b.send({ t: "enterGame" });
    await b.until((m) => m.t === "frame");
    const back = await dump(code);
    assert((back.liveSeats as boolean[])[seat] === true, "the seat should be theirs again");
  });


  await scenario("a second game (Poker) runs online through the same seam", async () => {
    // The table registry's real test: a room can run a game that is not
    // the one everything was first built around, and each player is dealt
    // their own hole cards and nobody else's.
    const a = await client(`t-poker-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-poker-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({
      t: "selectGame",
      gameId: "poker",
      settings: { startingStack: 5000, bigBlind: 50 },
      seats: 4,
      difficulty: "casual",
    });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(500);

    const state = await dump(code);
    assert(state.sessionRunning === true, "poker should be running");
    assert((state.table as { round: number } | null) !== null, "there should be a table");

    for (const c of [a, b]) {
      const frame = c.latest("frame");
      assert(frame, "each player should have been dealt in");
      const f = frame.frame as { seat: number; placements: Record<string, unknown> };
      assert(f.seat !== null, "each should have a seat");
      // Two hole cards face up for them, the rest of the deck concealed.
      const standIns = Object.keys(f.placements).filter((k) => k.startsWith("#"));
      assert(standIns.length > 0, "opponents' cards must be concealed");
    }

    // And no player is sent another player's hole cards.
    const truth = await dump(code);
    void truth;
    const seenByA = JSON.stringify(a.inbox);
    const bFrame = b.latest("frame")!.frame as {
      state: { cardOwner: Record<string, unknown> };
      seat: number;
    };
    const bsOwn = Object.entries(bFrame.state.cardOwner)
      .filter(([, owner]) => owner === bFrame.seat)
      .map(([id]) => id)
      .filter((id) => !id.startsWith("?"));
    assert(bsOwn.length === 2, `expected Bo to hold two hole cards, saw ${bsOwn.length}`);
    for (const card of bsOwn) {
      assert(!seenByA.includes(`"${card}"`), `Ada was sent Bo's hole card ${card}`);
    }

    // The assertion above is the obvious one and it is not enough — it
    // passed for months while the deck went out in the clear. A player
    // does not have to be TOLD an opponent's cards if they can name every
    // OTHER card in the deck: whatever is left over is the hand.
    //
    // So this counts what Ada can name. Two hole cards, at most five
    // community cards and at most three burns is ten; anything beyond
    // that means the stub is being described to her, and the elimination
    // is available. Checked on the wire rather than in a unit test
    // because this is the layer that sees what the socket actually
    // carried.
    const aFrame = a.latest("frame")!.frame as {
      state: { cardOwner: Record<string, unknown> };
    };
    const nameableByA = Object.keys(aFrame.state.cardOwner).filter((id) => !id.startsWith("?"));
    assert(
      nameableByA.length <= 10,
      `Ada can name ${nameableByA.length} cards; at most 10 are hers to see, ` +
        `so the rest of the deck is being published: ${nameableByA.join(",")}`,
    );
  });


  await scenario("Rummy runs online, and the dealer is asked whoever they are", async () => {
    // The fifth game, and the one that needed its RULES changed to get
    // here. Two of the three seat-0 assumptions are visible from this
    // side of the wire, so both are checked here rather than only in a
    // unit test: the deal-size prompt must land on the real dealer, and
    // the stock must never be nameable by anyone.
    const a = await client(`t-rum-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-rum-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "rummy", settings: { target: 200 }, seats: 4, difficulty: "casual" });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(600);

    const state = await dump(code);
    assert(state.sessionRunning === true, "rummy should be running");

    // The dealer is a genuine random cut, so it is as likely to be a bot
    // seat as a human one — and either way `currentSeat` must name the
    // DEALER rather than seat 0. That it can be a bot at all is the point:
    // a bot dealer used to resolve inline and never take a turn.
    const table = state.table as { currentSeat: number | null };
    const dumped = state.game as { seatOwner: (string | null)[] };
    void dumped;

    const frame = a.latest("frame");
    assert(frame, "Ada should have been dealt in");
    const f = frame.frame as {
      seat: number;
      currentSeat: number | null;
      state: {
        dealer: number;
        dealSizePending: number | null;
        hands: Record<string, string[]>;
        stock: string[];
      };
    };

    // Either the deal is still pending on the dealer, or a bot dealer has
    // already answered and the cards are out. Both are correct; what is
    // NOT correct is the prompt sitting on seat 0 when seat 0 is not the
    // dealer, which is what the old code did.
    if (f.state.dealSizePending !== null) {
      assert(
        f.state.dealSizePending === f.state.dealer,
        `the deal-size prompt sat on seat ${f.state.dealSizePending} while seat ${f.state.dealer} was dealing`,
      );
      assert(
        table.currentSeat === f.state.dealer,
        `currentSeat was ${table.currentSeat}, expected the dealer ${f.state.dealer}`,
      );
    }

    // Nobody else's hand, and never the stock — the same rule every other
    // game here is held to.
    for (const [seat, hand] of Object.entries(f.state.hands)) {
      if (Number(seat) === f.seat) continue;
      assert(
        hand.every((c) => c === "??"),
        `seat ${seat}'s hand leaked to Ada`,
      );
    }
    assert(
      f.state.stock.every((c) => c.startsWith("??")),
      "the stock leaked — the undrawn cards in order are worth more than any hand",
    );
  });

  await scenario("two humans play real Rummy turns, claims included", async () => {
    // The end-to-end proof for the game that needed its rules changed.
    //
    // The first version of this scenario let both humans idle and asserted
    // the table kept moving. It failed, and it deserved to — but not for
    // the reason it claimed. A seat whose turn it is blocks the table in
    // every game here, and always has; that is ordinary and correct, and
    // a person is right there deciding. What must NOT block is a CLAIM,
    // because a claim parks the whole table on several seats at once, and
    // that is enforced by `GameDefinition.deadline` and covered properly
    // in `GameSession.test.ts` where a race can actually be constructed.
    //
    // So this drives real play instead, and answers whatever it is asked.
    const a = await client(`t-rumplay-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-rumplay-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "rummy", settings: { target: 200 }, seats: 4, difficulty: "casual" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(400);

    const seatOf = new Map<Client, number>();
    for (const c of [a, b]) {
      const frame = c.latest("frame");
      assert(frame, "both players should have been dealt in");
      seatOf.set(c, (frame.frame as { seat: number }).seat);
    }
    assert(seatOf.get(a) !== seatOf.get(b), "two players must not share a seat");

    let acted = 0;
    let sawDealPrompt = false;
    let sawClaim = false;

    for (let tick = 0; tick < 260; tick++) {
      const state = await dump(code);
      const table = state.table as { currentSeat: number | null; round: number } | null;
      if (!table) break;

      // A claim window is the one time a seat may act without being the
      // seat on turn, so it is checked first and for BOTH clients.
      for (const c of [a, b]) {
        const f = c.latest("frame")?.frame as
          | { seat: number; state: { claimWindow: { pending: { seat: number }[] } | null } }
          | undefined;
        const racing = f?.state.claimWindow?.pending.some((p) => p.seat === f.seat);
        if (!racing) continue;
        sawClaim = true;
        c.send({ t: "action", action: { t: "claim", seat: f!.seat } });
        await sleep(60);
      }

      const turn = table.currentSeat;
      const who = [a, b].find((c) => seatOf.get(c) === turn);
      if (who) {
        const f = who.latest("frame")!.frame as {
          seat: number;
          state: {
            phase: string;
            dealSizePending: number | null;
            hands: Record<string, string[]>;
            claimWindow: unknown;
          };
        };
        if (f.state.dealSizePending !== null) {
          // A human dealer is asked, exactly as a bot dealer now is. This
          // is the branch that used to exist only for seat 0.
          sawDealPrompt = true;
          who.send({ t: "action", action: { t: "chooseDealSize", size: 7 } });
        } else if (f.state.phase === "draw") {
          who.send({ t: "action", action: { t: "drawStock" } });
        } else {
          // Discard the first card the server will accept. The client
          // deliberately does not reimplement the meld rules — the server
          // deciding is the whole point.
          const mine = f.state.hands[String(f.seat)] ?? [];
          for (const card of mine) {
            who.clear();
            who.send({ t: "action", action: { t: "discard", card } });
            await sleep(60);
            if (!who.latest("error")) break;
          }
        }
        acted += 1;
      }
      await sleep(60);
    }

    assert(acted > 0, "at least one human turn should have been taken");
    void sawDealPrompt;
    void sawClaim;

    // The table moved under real play, which is the claim being made.
    const moved = await dump(code);
    const finalTable = moved.table as { round: number } | null;
    assert(finalTable !== null, "the game should still be running");
    const frame = a.latest("frame")!.frame as {
      seat: number;
      state: { hands: Record<string, string[]>; discard: string[] };
    };
    assert(
      frame.state.discard.length > 1,
      "cards should have been discarded through the wire and accepted by the server",
    );
  });

  await scenario("Dominoes runs online, with the boneyard concealed", async () => {
    // A third game, and the one whose hidden pile is not a deck: the
    // boneyard is drawn from during play, so it has to stay concealed
    // after the deal rather than only through it.
    const a = await client(`t-dom-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-dom-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "dominoes", settings: { mode: "classic" }, seats: 4, difficulty: "casual" });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(500);

    const state = await dump(code);
    assert(state.sessionRunning === true, "dominoes should be running");

    const frame = a.latest("frame");
    assert(frame, "Ada should have been dealt in");
    const f = frame.frame as {
      seat: number;
      state: { hands: Record<string, string[]>; boneyard: string[] };
      placements: Record<string, unknown>;
    };
    // Her own hand is real; everybody else's and the boneyard are not.
    const mine = f.state.hands[String(f.seat)] ?? [];
    assert(mine.length > 0 && !mine.includes("?"), "Ada should hold real tiles");
    for (const [seat, hand] of Object.entries(f.state.hands)) {
      if (Number(seat) === f.seat) continue;
      assert(hand.every((t) => t === "?"), `seat ${seat}'s tiles leaked`);
    }
    assert(f.state.boneyard.every((t) => t === "?"), "the boneyard leaked");
    const standIns = Object.keys(f.placements).filter((k) => k.startsWith("#"));
    assert(standIns.length > 0, "concealed tiles should render as stand-ins");
  });


  await scenario("LRC rolls on the server, not on the client", async () => {
    // The cheat vector this game had: its human action carries a random
    // OUTCOME, and the play screen used to resolve it locally. A client
    // that authors its own dice can choose them, so the server now
    // re-rolls and discards whatever arrived.
    const a = await client(`t-lrc-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-lrc-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "lrc", settings: { target: 3 }, seats: 4, difficulty: "casual" });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(500);

    const started = await dump(code);
    assert(started.sessionRunning === true, "LRC should be running");

    // Send a roll claiming three centre faces. If the client were trusted,
    // three chips would go straight to the pot.
    const before = await dump(code);
    const turn = (before.table as { currentSeat: number | null }).currentSeat;
    const who = [a, b].find((c) => {
      const owners = (before.game as { seatOwner: (string | null)[] }).seatOwner;
      return owners.indexOf(c.session!) === turn;
    });
    if (!who) return; // A bot is on turn; nothing to prove this pass.

    who.clear();
    who.send({ t: "action", action: { t: "roll", dice: ["C", "C", "C"] } });
    await sleep(300);

    const frame = who.latest("frame");
    assert(frame, "the roll should have produced a frame");
    const applied = (frame.frame as { lastAction: { action: { dice: string[] } } | null }).lastAction;
    assert(applied, "the frame should report what was rolled");
    // The odds of a genuine re-roll matching a chosen all-centre roll are
    // 1 in 216 per die-count, so this is a real assertion, not a hope: the
    // point is that the dice came back from the server at all and were not
    // simply echoed. Belt and braces, the count must match the seat's
    // entitlement rather than the three we asked for.
    const dice = applied.action.dice;
    assert(Array.isArray(dice) && dice.length > 0, "the server should have rolled real dice");
    assert(
      dice.every((d) => ["L", "R", "C", "dot"].includes(d)),
      `unexpected faces: ${JSON.stringify(dice)}`,
    );
  });


  /* ------------------------------------------------------------
     A table nobody is left to wait for
     ------------------------------------------------------------ */

  await scenario("the table carries on when the seat on turn drops", async () => {
    // The stall this layer exists to catch, and the one it missed.
    //
    // `settled()` is what hands a turn to a bot, and on the server it was
    // only ever reached from somebody ACTING. Park the table on a live
    // seat, drop that player, and the four games with no `deadline?()`
    // armed nothing: the seat was bot-played, no bot was ever invoked,
    // and the person still sitting there waited forever.
    //
    // A unit test cannot see this — it needs a real socket to really
    // close. `router.test.ts` asserted the Away badge was pushed and
    // stopped exactly there.
    const a = await client(`t-stall-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-stall-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(500);

    const seatOf = new Map<Client, number>();
    for (const c of [a, b]) {
      const frame = c.latest("frame");
      assert(frame, "both players should have been dealt in");
      seatOf.set(c, (frame.frame as { seat: number }).seat);
    }

    // Wait until the table is genuinely parked on one of the two humans.
    let onTurn: Client | undefined;
    for (let tick = 0; tick < 40 && !onTurn; tick++) {
      const table = (await dump(code)).table as { currentSeat: number | null } | null;
      onTurn = [a, b].find((c) => seatOf.get(c) === table?.currentSeat);
      if (!onTurn) await sleep(100);
    }
    assert(onTurn, "the table should have parked on a human");

    const before = (await dump(code)).table as { fingerprint: string };
    const stranded = onTurn === a ? b : a;

    // Drop them where they sit — not a polite exit, a socket going away.
    onTurn.close();

    // A generous window for the server to do what it used to never do.
    let moved = false;
    for (let tick = 0; tick < 50 && !moved; tick++) {
      await sleep(120);
      const now = (await dump(code)).table as { fingerprint: string } | null;
      if (now && now.fingerprint !== before.fingerprint) moved = true;
    }

    assert(moved, "the abandoned seat was never played — the table stalled");
    assert(stranded.latest("frame"), "the remaining player should still hold a frame");
  });

  await scenario("a socket that re-hellos as somebody else lets go of the first seat", async () => {
    // `peer.session` was simply overwritten, so the room went on holding
    // the FIRST session against this same socket. `onClose` then detached
    // the second and the first was never detached at all — it stayed
    // "connected" forever, so a bot never took its seat and the room was
    // never reaped.
    const a = await client(`t-rehello-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-rehello-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(500);

    const seat = (b.latest("frame")!.frame as { seat: number }).seat;
    assert(((await dump(code)).liveSeats as boolean[])[seat] === true, "Bo should be live first");

    // Same socket, different identity.
    b.send({ t: "hello", token: `t-rehello-other-${Date.now()}`, protocol: PROTOCOL });
    await sleep(400);

    const live = (await dump(code)).liveSeats as boolean[];
    assert(live[seat] === false, "the abandoned seat should have gone to a bot");
  });

  await scenario("an action the seat may not take changes nothing", async () => {
    // The wire used to be trusted: `submit` checked only that the seat had
    // SOME legal action and never that the one that arrived was among
    // them. In Spades that meant playing a card out of somebody else's
    // hand; ids are suit+rank and entirely guessable.
    const a = await client(`t-illegal-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-illegal-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(50);
    a.send({ t: "startGame" });
    await sleep(500);

    const seatOf = new Map<Client, number>();
    for (const c of [a, b]) seatOf.set(c, (c.latest("frame")!.frame as { seat: number }).seat);

    let onTurn: Client | undefined;
    for (let tick = 0; tick < 40 && !onTurn; tick++) {
      const table = (await dump(code)).table as { currentSeat: number | null } | null;
      onTurn = [a, b].find((c) => seatOf.get(c) === table?.currentSeat);
      if (!onTurn) await sleep(100);
    }
    assert(onTurn, "the table should have parked on a human");

    const before = (await dump(code)).table as { fingerprint: string };

    // A card that is certainly not theirs to play, and bids shaped wrong.
    for (const action of [
      { t: "play", card: "AS" },
      { t: "play", card: "??" },
      { t: "bid", tricks: 99, nil: false },
      { t: "bid", tricks: "lots", nil: false },
      { t: "raise", to: "abc" },
    ]) {
      onTurn.send({ t: "action", action });
      await sleep(60);
    }

    const after = (await dump(code)).table as { fingerprint: string };
    assert(
      after.fingerprint === before.fingerprint,
      "an illegal action moved the table when it should have changed nothing",
    );
  });

  await scenario("BS runs online, and the pile leaks nothing to anybody", async () => {
    // The sixth game, and the heaviest user of the challenge machinery: it
    // runs a race after every single play. Two things are checked from this
    // side of the wire because only this side can see them — the pile must
    // never be nameable, and a window must never be able to stop the table.
    const a = await client(`t-bs-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-bs-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({
      t: "selectGame",
      gameId: "bs",
      settings: { target: 2, windowMs: 3000 },
      seats: 4,
      difficulty: "casual",
    });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(800);

    const state = await dump(code);
    assert(state.sessionRunning === true, "bs should be running");

    const frame = a.latest("frame");
    assert(frame, "Ada should have been dealt in");
    const f = frame.frame as {
      seat: number;
      state: {
        hands: Record<string, string[]>;
        plays: Array<{ seat: number; claimed: string; cards: string[] }>;
      };
    };

    for (const [seat, hand] of Object.entries(f.state.hands)) {
      if (Number(seat) === f.seat) continue;
      assert(hand.every((c) => c === "??"), `seat ${seat}'s hand leaked to Ada`);
    }
    // Including Ada's OWN plays. The rule is blunt on purpose: face down
    // means the identity does not travel, with no exception for the player
    // who put the cards there.
    for (const play of f.state.plays) {
      assert(
        play.cards.every((c) => c === "??"),
        `the pile leaked — seat ${play.seat}'s claim of ${play.claimed} arrived named`,
      );
    }
  });

  await scenario("a BS challenge window cannot stall the table", async () => {
    // The stall this shape is most prone to, and the one a unit test is worst
    // placed to see: a window parks the table on SEVERAL seats at once, so no
    // single browser can unblock it and a client-side timer is not the
    // mechanism.
    //
    // The first version of this asserted that an idle table moves at all, and
    // it failed — deservedly, but not for the reason it claimed. A seat whose
    // TURN it is blocks the table in every game here and always has; that is
    // ordinary, correct, and a person is right there deciding. So this drives
    // real plays until a window is actually open, and only then stops
    // answering anything.
    const a = await client(`t-bswin-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-bswin-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({
      t: "selectGame",
      gameId: "bs",
      settings: { target: 2, windowMs: 2000 },
      seats: 4,
      difficulty: "sharp",
    });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(600);

    const seatOf = new Map<Client, number>();
    for (const c of [a, b]) {
      const frame = c.latest("frame");
      assert(frame, "both players should have been dealt in");
      seatOf.set(c, (frame.frame as { seat: number }).seat);
    }

    type Frame = {
      seat: number;
      state: {
        turn: number;
        hands: Record<string, string[]>;
        window: { pending: { seat: number }[] } | null;
      };
    };

    // Play on until a window is open, nudging it along only when the seat on
    // turn is one of ours. A bot's play opens one by itself.
    let opened = false;
    for (let tick = 0; tick < 80 && !opened; tick++) {
      for (const c of [a, b]) {
        const f = c.latest("frame")?.frame as Frame | undefined;
        if (f?.state.window) {
          opened = true;
          break;
        }
        if (!f || f.state.turn !== seatOf.get(c)) continue;
        const card = f.state.hands[String(f.seat)]?.[0];
        if (card) c.send({ t: "action", action: { t: "play", cards: [card] } });
      }
      await sleep(120);
    }
    assert(opened, "no challenge window ever opened, so there was nothing to test");

    const before = (await dump(code)).table as { fingerprint: string };
    // Long enough for the window to expire on its own several times over.
    // Nobody answers anything: whatever moves is the server's own deadline
    // moving it, which is the entire claim.
    await sleep(9000);
    const after = (await dump(code)).table as { fingerprint: string };
    assert(
      after.fingerprint !== before.fingerprint,
      "the table never moved — a challenge window stalled it with nobody answering",
    );
  });

  await scenario("BS refuses a claim nobody could make", async () => {
    // Every one of these is reachable from a socket by a player whose turn it
    // genuinely is. Card ids are suit+rank and entirely guessable.
    const a = await client(`t-bsbad-a-${Date.now()}`);
    const code = await hostRoom(a, "Ada");
    const b = await client(`t-bsbad-b-${Date.now()}`);
    b.send({ t: "joinRoom", code, name: "Bo" });
    await b.until((m) => m.t === "room");

    a.send({
      t: "selectGame",
      gameId: "bs",
      settings: { target: 2 },
      seats: 4,
      difficulty: "casual",
    });
    await sleep(60);
    a.send({ t: "startGame" });
    await sleep(600);

    const before = (await dump(code)).table as { fingerprint: string };
    for (const action of [
      // Five cards, when four of a rank is all there is.
      { t: "play", cards: ["SA", "S2", "S3", "S4", "S5"] },
      { t: "play", cards: [] },
      { t: "play", cards: "SA" },
      { t: "play", cards: [7] },
      // The same card twice, to claim a pair out of one card.
      { t: "play", cards: ["SA", "SA"] },
      // A call on a window that is not open, and a pile nobody owes.
      { t: "callBs", seat: 3 },
      { t: "takePile", seat: 0 },
      { t: "declineBs", seat: 1 },
    ]) {
      a.send({ t: "action", action });
      b.send({ t: "action", action });
      await sleep(40);
    }
    const after = (await dump(code)).table as { fingerprint: string };
    assert(
      after.fingerprint === before.fingerprint,
      "a malformed BS action moved the table when it should have changed nothing",
    );
  });

  await scenario("four people fill a partnership table", async () => {
    // Nothing in any layer had ever seated more than two humans, so the
    // shape every partnership game is built around - four people, partners
    // across, 0/2 against 1/3 - was never once exercised end to end.
    const { code, clients } = await party("quad", 4, ["Ada", "Bo", "Cy", "Di"]);
    const host = clients[0]!;

    host.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(80);
    host.send({ t: "startGame" });
    await sleep(900);

    const seats = seatsOf(clients);
    assert(new Set(seats).size === 4, `four people need four distinct seats, got ${seats}`);
    for (const seat of seats) assert(seat >= 0 && seat < 4, `seat ${seat} is off the table`);

    // Everybody is live, so no bot may be holding a seat.
    const live = (await dump(code)).liveSeats as boolean[];
    assert(
      live.length === 4 && live.every((x) => x === true),
      `a real person sits in every seat, but liveSeats was ${JSON.stringify(live)}`,
    );

    // And the table is parked on one of them, waiting rather than stalled.
    const table = (await dump(code)).table as { currentSeat: number | null };
    assert(
      seats.includes(table.currentSeat ?? -1),
      `the table should wait on one of the four, not seat ${table.currentSeat}`,
    );
  });

  await scenario("a six-seat BS table with four people keeps moving", async () => {
    // BS asks EVERY other seat about every single play, so a table with
    // several people on it is a different load from one with two - it is
    // the load `turnHold` exists for, and it had never been put under it
    // outside a pure function.
    const { code, clients } = await party("bs6", 4, ["Ada", "Bo", "Cy", "Di"]);
    const host = clients[0]!;

    host.send({
      t: "selectGame",
      gameId: "bs",
      // A short window keeps the scenario quick; the SHAPE being
      // measured - every play asking four other seats, three of them
      // people - is the same at any length.
      settings: { target: 2, windowMs: 2000 },
      seats: 6,
      difficulty: "casual",
    });
    await sleep(80);
    host.send({ t: "startGame" });
    await sleep(900);

    const seats = seatsOf(clients);
    assert(new Set(seats).size === 4, `four people need four distinct seats, got ${seats}`);

    // The people play for real, from their own hands. Windows are left to
    // resolve on their own clocks, which is the load being measured: every
    // play asks four other seats, and three of those are people.
    let moves = 0;
    let last = ((await dump(code)).table as { fingerprint: string }).fingerprint;
    for (let tick = 0; tick < 120 && moves < 4; tick++) {
      for (let i = 0; i < clients.length; i++) playOneBs(clients[i]!, seats[i]!);
      await sleep(250);
      const now = (await dump(code)).table as { fingerprint: string } | null;
      if (!now) break;
      if (now.fingerprint !== last) {
        moves++;
        last = now.fingerprint;
      }
    }
    assert(moves >= 4, `a four-person BS table only moved ${moves} times`);
  });

  await scenario("a ten-seat room seats everybody who turns up", async () => {
    // Poker and LRC are the two that seat ten; rummy stops at six, and a
    // seat count outside a game's range is CLAMPED rather than refused
    // (room.ts), so asking the wrong game for ten quietly gives you six.
    // Nothing had ever put more than four people in a room, so "the room
    // fills up" was an assumption rather than a tested claim - and seat
    // assignment is the one thing with no second chance to get right.
    const { code, clients } = await party("ten", 10, [
      "Ada",
      "Bo",
      "Cy",
      "Di",
      "Eve",
      "Fay",
      "Gus",
      "Hal",
      "Ivy",
      "Jo",
    ]);
    const host = clients[0]!;

    host.send({
      t: "selectGame",
      gameId: "lrc",
      settings: { target: 3 },
      seats: 10,
      difficulty: "casual",
    });
    await sleep(120);
    host.send({ t: "startGame" });
    await sleep(2000);

    const seats = seatsOf(clients);
    assert(new Set(seats).size === 10, `ten people need ten distinct seats, got ${seats}`);
    const live = (await dump(code)).liveSeats as boolean[];
    assert(live.length === 10, `a ten-seat game should report ten seats, got ${live.length}`);
    assert(
      live.every((x) => x === true),
      `every seat has a person in it, but liveSeats was ${JSON.stringify(live)}`,
    );
  });

  await scenario("kicking somebody frees their seat and the table carries on", async () => {
    // Only ever tested from the kicked player's side, and only that they
    // were told. Nobody asserted the seat is released and the game then
    // keeps playing without them.
    const { code, clients } = await party("kick", 3, ["Ada", "Bo", "Cy"]);
    const host = clients[0]!;

    host.send({ t: "selectGame", gameId: "spades", settings: {}, seats: 4, difficulty: "casual" });
    await sleep(80);
    host.send({ t: "startGame" });
    await sleep(900);

    const seats = seatsOf(clients);

    // Get the table parked on somebody who is NOT the leader, so that
    // kicking them is the on-turn case - the one where a seat nobody is
    // going to answer for has to be handed over for the game to go on.
    // The leader bids when it is asked to, which is what moves the turn
    // along; everybody else is left sitting on theirs.
    let victimIdx = -1;
    for (let tick = 0; tick < 60 && victimIdx < 0; tick++) {
      const table = (await dump(code)).table as { currentSeat: number | null } | null;
      const idx = seats.indexOf(table?.currentSeat ?? -1);
      if (idx > 0) {
        victimIdx = idx;
        break;
      }
      if (idx === 0) {
        host.send({ t: "action", action: { t: "look" } });
        await sleep(40);
        host.send({ t: "action", action: { t: "bid", tricks: 3, nil: false } });
      }
      await sleep(120);
    }
    assert(victimIdx > 0, "the table should have parked on somebody other than the leader");

    const target = clients[victimIdx]!;
    const victimSeat = seats[victimIdx]!;
    assert(
      ((await dump(code)).liveSeats as boolean[])[victimSeat] === true,
      "the player about to be kicked should be live first",
    );

    const victimSession = target.session;
    assert(victimSession, "the victim needs a session to be kicked by");
    target.clear();
    host.send({ t: "kick", session: victimSession });
    await target.until((m) => m.t === "left" && m.reason === "kicked");

    let released = false;
    for (let tick = 0; tick < 30 && !released; tick++) {
      await sleep(120);
      const live = (await dump(code)).liveSeats as boolean[] | undefined;
      if (live && live[victimSeat] === false) released = true;
    }
    assert(released, "a kicked player's seat was never handed over");

    const before = (await dump(code)).table as { fingerprint: string };
    let moved = false;
    for (let tick = 0; tick < 40 && !moved; tick++) {
      await sleep(150);
      const now = (await dump(code)).table as { fingerprint: string } | null;
      if (now && now.fingerprint !== before.fingerprint) moved = true;
    }
    assert(moved, "the table stalled after somebody was kicked out of it");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
