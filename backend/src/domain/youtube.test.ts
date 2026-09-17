import { describe, expect, test } from "bun:test";
import { embedUrlFor, parseYouTubeId } from "./youtube.ts";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeId", () => {
  test("reads every share shape YouTube hands out", () => {
    const urls = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/v/${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ];
    for (const url of urls) expect(parseYouTubeId(url)).toBe(ID);
  });

  test("ignores timestamp and playlist query junk", () => {
    // The share button adds these constantly; they must not defeat the parse.
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}&t=42s`)).toBe(ID);
    expect(parseYouTubeId(`https://youtu.be/${ID}?t=42`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}&list=PL123&index=2`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/watch?list=PL123&v=${ID}`)).toBe(ID);
  });

  test("tolerates a missing scheme and surrounding whitespace", () => {
    expect(parseYouTubeId(`youtu.be/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`  www.youtube.com/watch?v=${ID}  `)).toBe(ID);
    expect(parseYouTubeId(`http://youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  test("accepts a bare id, since creators paste that too", () => {
    expect(parseYouTubeId(ID)).toBe(ID);
  });

  test("rejects anything that is not a YouTube video", () => {
    const bad = [
      "", "   ", null, undefined,
      "https://vimeo.com/123456",
      "https://example.com/watch?v=dQw4w9WgXcQ",       // right shape, wrong host
      "https://www.youtube.com/",                       // no id
      "https://www.youtube.com/watch",                  // no v param
      "https://www.youtube.com/channel/UC123",          // not a video
      "https://www.youtube.com/watch?v=tooshort",       // id is not 11 chars
      "https://www.youtube.com/watch?v=waaaaaaaaaaytoolong",
      "https://www.youtube.com/watch?v=has spaces",
      "not a url at all",
      "javascript:alert(1)",
    ];
    for (const url of bad) expect(parseYouTubeId(url)).toBeNull();
  });

  test("does not let a lookalike host through", () => {
    // youtube.com.evil.test ends with nothing we trust; exact host match only.
    expect(parseYouTubeId(`https://youtube.com.evil.test/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeId(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
  });
});

describe("embedUrlFor", () => {
  test("builds a nocookie embed url", () => {
    expect(embedUrlFor(ID)).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
  });
});
