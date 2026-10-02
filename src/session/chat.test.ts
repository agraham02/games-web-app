// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CHAT_MAX_CHARS,
  QUICK_REPLIES,
  charCount,
  chatTextProblem,
  cleanChatText,
  quickReply,
} from "./chat";

describe("cleanChatText", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanChatText("  hello \n\n  there\t ")).toBe("hello there");
  });

  it("removes control characters", () => {
    expect(cleanChatText("a\u0000b\u0007c\u009Fd")).toBe("abcd");
  });

  it("removes direction overrides, which can make text say what it does not", () => {
    expect(cleanChatText("nice ‮eno doog‬ move")).toBe("nice eno doog move");
    expect(cleanChatText("⁦x⁩")).toBe("x");
  });

  it("caps stacked accents, so one character cannot climb over the lines above", () => {
    const zalgo = "e" + "́".repeat(40);
    expect(cleanChatText(zalgo)).toBe("é́́");
    // An ordinary accent is left alone.
    expect(cleanChatText("café")).toBe("café");
  });
});

describe("how long a message is", () => {
  it("counts characters as a person does", () => {
    expect(charCount("👍🏽")).toBe(1);
    expect(charCount("👨‍👩‍👧")).toBe(1);
    expect(charCount("hi")).toBe(2);
  });

  it("refuses nothing, and too much", () => {
    expect(chatTextProblem("")).toBe("empty");
    expect(chatTextProblem("x".repeat(CHAT_MAX_CHARS))).toBeNull();
    expect(chatTextProblem("x".repeat(CHAT_MAX_CHARS + 1))).toBe("too-long");
    // 120 flags are 120 characters and 960 bytes: the byte cap catches it.
    expect(chatTextProblem("🇬🇧".repeat(CHAT_MAX_CHARS))).toBe("too-long");
  });
});

describe("the quick replies", () => {
  it("are distinct, findable, and each fits in a message", () => {
    const ids = QUICK_REPLIES.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of QUICK_REPLIES) {
      expect(quickReply(q.id)).toBe(q);
      expect(chatTextProblem(q.text)).toBeNull();
    }
    expect(quickReply("nope")).toBeNull();
  });

  it("leave something to say during a hand, and only the social things", () => {
    const safe = QUICK_REPLIES.filter((q) => q.tableSafe).map((q) => q.text);
    expect(safe).toEqual(["😂", "👋", "Good luck!", "Hurry up!", "brb", "I'm back!"]);
  });
});
