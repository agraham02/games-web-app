// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Collapse } from "./index";

/**
 * A ring (a tile's border, a focus outline) is drawn outside the element
 * that owns it, so a box that clips its content cuts it off at the edges.
 * `Collapse` clipped all the time, and the lobby's game tiles lost their
 * outer borders to it (the user, 2026-09-27). It may clip while it moves;
 * at rest it must not.
 */
describe("Collapse", () => {
  it("does not clip what it holds once it is open", () => {
    render(
      <Collapse open>
        <div data-testid="content" />
      </Collapse>,
    );
    const box = screen.getByTestId("content").parentElement!;
    expect(box.style.overflow).toBe("visible");
  });
});
