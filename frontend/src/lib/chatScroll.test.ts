import { describe, expect, test } from "bun:test";
import { isNearBottom, threadChanged, STICK_THRESHOLD_PX } from "./chatScroll";
import type { ApiMessage } from "./api";

const msg = (id: string): ApiMessage => ({
  id, sender: "them", body: id, createdAt: "2026-09-17T05:00:00.000Z", attachments: [],
});

describe("isNearBottom", () => {
  test("true when the thread is scrolled to the very bottom", () => {
    expect(isNearBottom({ scrollTop: 400, scrollHeight: 800, clientHeight: 400 })).toBe(true);
  });

  test("true within the threshold, so a half-scrolled line still counts as following", () => {
    expect(isNearBottom({ scrollTop: 400 - STICK_THRESHOLD_PX, scrollHeight: 800, clientHeight: 400 })).toBe(true);
  });

  test("false when the reader has scrolled up into history", () => {
    // THE point of this function: a poll must not yank the view down while
    // someone is reading what was said ten minutes ago.
    expect(isNearBottom({ scrollTop: 100, scrollHeight: 800, clientHeight: 400 })).toBe(false);
  });

  test("true for a thread shorter than its window", () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true);
  });
});

describe("threadChanged", () => {
  test("a thread that has never loaded counts as changed", () => {
    expect(threadChanged(undefined, [])).toBe(true);
  });

  test("an unchanged poll result is not a change", () => {
    // Without this, every 5s tick re-renders the window and re-fires the scroll
    // effect even when nobody said anything.
    const thread = [msg("a"), msg("b")];
    expect(threadChanged(thread, [msg("a"), msg("b")])).toBe(false);
  });

  test("a new message at the end is a change", () => {
    expect(threadChanged([msg("a")], [msg("a"), msg("b")])).toBe(true);
  });

  test("a deleted message is a change", () => {
    expect(threadChanged([msg("a"), msg("b")], [msg("a")])).toBe(true);
  });

  test("two empty threads are unchanged", () => {
    expect(threadChanged([], [])).toBe(false);
  });
});
