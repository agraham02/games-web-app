// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/session/chat";
import { ChatSheet } from "./ChatSheet";

afterEach(cleanup);

const said = (id: number, session: string, name: string, text: string): ChatMessage => ({
  id,
  session,
  name,
  text,
  at: id,
});

function sheet(opts: { mode?: "open" | "quick-only"; messages?: ChatMessage[] } = {}) {
  const onSend = vi.fn();
  render(
    <ChatSheet
      open
      onClose={() => {}}
      messages={opts.messages ?? []}
      you="me"
      mode={opts.mode ?? "open"}
      onSend={onSend}
    />,
  );
  return onSend;
}

describe("the chat sheet", () => {
  it("shows who said what, and calls your own lines yours", () => {
    sheet({ messages: [said(1, "bo", "Bo", "hi all"), said(2, "me", "Ada", "hello")] });
    const log = screen.getByRole("list", { name: "Messages" });
    expect(within(log).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Bohi all", "Youhello"]);
  });

  it("says so when nothing has been said", () => {
    sheet();
    expect(screen.getByText(/nothing said yet/i)).toBeTruthy();
  });

  it("sends what was typed, cleaned, and empties the field", () => {
    const onSend = sheet();
    const field = screen.getByLabelText("Message") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  good   game  " } });
    fireEvent.submit(field.closest("form")!);
    expect(onSend).toHaveBeenCalledWith({ text: "good game" });
    expect(field.value).toBe("");
  });

  it("will not send nothing, or too much", () => {
    const onSend = sheet();
    const field = screen.getByLabelText("Message");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "x".repeat(125) } });
    expect(screen.getByText("5 too many")).toBeTruthy();
    fireEvent.submit(field.closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("counts down only near the limit", () => {
    sheet();
    const field = screen.getByLabelText("Message");
    fireEvent.change(field, { target: { value: "x".repeat(50) } });
    expect(screen.queryByText(/left$/)).toBeNull();
    fireEvent.change(field, { target: { value: "x".repeat(110) } });
    expect(screen.getByText("10 left")).toBeTruthy();
  });

  it("sends a quick reply by its id", () => {
    const onSend = sheet();
    fireEvent.click(within(screen.getByRole("group", { name: "Quick replies" })).getByText("Good luck!"));
    expect(onSend).toHaveBeenCalledWith({ quick: "luck" });
  });

  it("during a hand you are in, offers only the table-safe replies — dimmed, not gone", () => {
    const onSend = sheet({ mode: "quick-only" });
    expect(screen.getByLabelText("Message")).toBeDisabled();
    const row = within(screen.getByRole("group", { name: "Quick replies" }));
    expect(row.getByText("Nice one!")).toBeDisabled();
    expect(row.getByText("👍")).toBeDisabled();
    expect(row.getByText("Thanks!")).toBeEnabled();
    fireEvent.click(row.getByText("Thanks!"));
    expect(onSend).toHaveBeenCalledWith({ quick: "thanks" });
    expect(screen.getByLabelText("Message")).toHaveAttribute("placeholder", "No table talk until the hand is over");
  });
});
