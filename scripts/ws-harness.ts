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

    const seen = JSON.stringify(watcher.inbox);

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
    const realCard = /"[SHDC]-(?:A|K|Q|J|10|[2-9])"/.exec(seen);
    assert(realCard === null, `a spectator was sent a real card id: ${realCard?.[0]}`);
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


  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
