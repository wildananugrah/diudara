import { describe, expect, test } from "bun:test";
import { OpenRouterCommunityBuilder } from "./OpenRouterCommunityBuilder.ts";

const parse = OpenRouterCommunityBuilder.parseTurn;

describe("parseTurn", () => {
  test("uses the model's reply when it wrote one", () => {
    const turn = parse('{"reply":"Komunitas kamu tentang apa?","done":false,"draft":{}}');
    expect(turn.reply).toBe("Komunitas kamu tentang apa?");
    expect(turn.done).toBe(false);
  });

  test("never echoes raw JSON when the model leaves reply empty", () => {
    // The bug: the model obeys the format, fills draft, leaves reply blank —
    // and the whole JSON object used to land in the chat bubble.
    const turn = parse('{"reply":"","done":false,"draft":{"name":"Belajar Desain"}}');
    expect(turn.reply).not.toContain("{");
    expect(turn.reply).not.toContain("draft");
    expect(turn.reply.length).toBeGreaterThan(0);
    // The draft it did report still has to survive.
    expect(turn.draft).toEqual({ name: "Belajar Desain" });
  });

  test("keeps the draft and done flag from a well-formed turn", () => {
    const turn = parse('{"reply":"Siap!","done":true,"draft":{"category":"Edukasi"}}');
    expect(turn.done).toBe(true);
    expect(turn.draft).toEqual({ category: "Edukasi" });
  });

  test("unwraps a ```json fence", () => {
    const turn = parse('```json\n{"reply":"Halo","done":false,"draft":{}}\n```');
    expect(turn.reply).toBe("Halo");
  });

  test("falls back to prose when the model ignored the JSON instruction", () => {
    const turn = parse("Halo! Komunitas kamu tentang apa?");
    expect(turn.reply).toBe("Halo! Komunitas kamu tentang apa?");
    expect(turn.done).toBe(false);
    expect(turn.draft).toEqual({});
  });

  test("treats a bare JSON scalar as prose, not as a turn", () => {
    expect(parse('"halo"').reply).toBe('"halo"');
    expect(parse("null").reply).toBe("null");
  });

  test("ignores a non-object draft rather than passing it through", () => {
    expect(parse('{"reply":"hai","draft":"bukan objek"}').draft).toEqual({});
    expect(parse('{"reply":"hai","draft":null}').draft).toEqual({});
  });

  test("only honours done when it is exactly true", () => {
    expect(parse('{"reply":"hai","done":"true","draft":{}}').done).toBe(false);
    expect(parse('{"reply":"hai","done":1,"draft":{}}').done).toBe(false);
  });

  test("treats a placeholder reply as empty rather than showing it", () => {
    // gpt-4o-mini copies the prompt's skeleton verbatim, so "..." arrives as the
    // reply and the assistant appears to say nothing at all.
    for (const placeholder of ['"..."', '"…"', '"  "', '". . ."']) {
      const turn = parse(`{"reply":${placeholder},"done":false,"draft":{}}`);
      expect(turn.reply).not.toMatch(/^[.…\s]*$/);
      expect(turn.reply.length).toBeGreaterThan(0);
    }
  });

  test("drops blank draft fields so they cannot overwrite known values", () => {
    // The client merges with {...prev, ...draft}; a blank "name" here would wipe
    // a name the user already gave two turns ago.
    const turn = parse(
      '{"reply":"Lanjut","draft":{"name":"","niche":"UI/UX pemula","category":"  ","description":"","tiers":[]}}',
    );
    expect(turn.draft).toEqual({ niche: "UI/UX pemula" });
  });

  test("keeps populated draft fields untouched", () => {
    const turn = parse(
      '{"reply":"Oke","draft":{"name":"Kelas Desain","tiers":[{"name":"Dasar","priceCents":14900000}]}}',
    );
    expect(turn.draft).toEqual({
      name: "Kelas Desain",
      tiers: [{ name: "Dasar", priceCents: 14900000 }],
    });
  });
});
