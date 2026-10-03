import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PROTOCOL_VERSION, type ServerMessage } from "@/session/protocol";
import { RoomRegistry } from "./RoomRegistry";
import { attachWebSocketServer, WS_PATH } from "./wsServer";

/** A real socket against the real adapter, on a port the OS picks. */
describe("wsServer", () => {
  let server: Server | null = null;
  let detach: (() => void) | null = null;
  afterEach(async () => {
    detach?.();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = null;
    detach = null;
  });

  async function connect(): Promise<{ socket: WebSocket; next: () => Promise<ServerMessage> }> {
    server = createServer();
    detach = attachWebSocketServer(server, new RoomRegistry());
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
    const { port } = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    const inbox: ServerMessage[] = [];
    const waiting: Array<(m: ServerMessage) => void> = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      const take = waiting.shift();
      if (take) take(message);
      else inbox.push(message);
    });
    await new Promise<void>((done, fail) => {
      socket.once("open", () => done());
      socket.once("error", fail);
    });
    const next = () =>
      new Promise<ServerMessage>((done) => {
        const ready = inbox.shift();
        if (ready) done(ready);
        else waiting.push(done);
      });
    return { socket, next };
  }

  it("compresses what it sends, and still speaks the protocol", async () => {
    const { socket, next } = await connect();
    // A frame is a whole snapshot, nearly all of it the same as the last:
    // compressed with a shared window, a turn is a few hundred bytes.
    expect(socket.extensions).toContain("permessage-deflate");
    socket.send(JSON.stringify({ t: "hello", token: "ada", protocol: PROTOCOL_VERSION }));
    expect((await next()).t).toBe("hello");
    socket.send(JSON.stringify({ t: "createRoom", name: "Ada" }));
    const room = await next();
    expect(room.t).toBe("room");
    socket.close();
  });
});
