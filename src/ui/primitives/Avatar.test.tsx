// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

afterEach(cleanup);

describe("Avatar", () => {
  it("draws a photo over the initials", () => {
    const { container } = render(<Avatar name="Ada" colour="red" src="/api/photo/abc" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/photo/abc");
    // Still there underneath, for while it loads.
    expect(container.textContent).toBe("AD");
  });

  it("falls back to the initials when the photo cannot be loaded", () => {
    // Taken down, or the room closed: a broken-image box would be worse.
    const { container } = render(<Avatar name="Ada" colour="red" src="/api/photo/gone" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("AD");
  });

  it("tries a new photo even after an old one failed", () => {
    const { container, rerender } = render(<Avatar name="Ada" colour="red" src="/api/photo/gone" />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<Avatar name="Ada" colour="red" src="/api/photo/new" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/photo/new");
  });
});
