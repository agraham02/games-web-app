// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionNotice } from "./ConnectionNotice";

afterEach(cleanup);

describe("ConnectionNotice, when the turn timer gave your seat to a bot", () => {
  it("says so, and gives you the way back", () => {
    const onResume = vi.fn();
    render(<ConnectionNotice status="open" idle onResume={onResume} />);
    expect(screen.getByRole("status").textContent).toContain("A bot is playing for you");
    fireEvent.click(screen.getByRole("button", { name: "I'm back" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("says nothing while you are playing", () => {
    render(<ConnectionNotice status="open" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
