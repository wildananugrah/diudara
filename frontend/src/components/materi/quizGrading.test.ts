import { describe, expect, test } from "bun:test";
import { optionStateFor, tally } from "./quizGrading";

const right = { id: "a", isCorrect: true };
const wrong = { id: "b", isCorrect: false };
const other = { id: "c", isCorrect: false };

describe("optionStateFor", () => {
  test("shows nothing before the member has answered", () => {
    // Otherwise the key is visible in the colours and the quiz answers itself.
    expect(optionStateFor(right, null, false)).toBe("idle");
    expect(optionStateFor(wrong, null, false)).toBe("idle");
  });

  test("marks the picked option right when it is right", () => {
    expect(optionStateFor(right, "a", true)).toBe("correct");
  });

  test("marks the picked option wrong and still highlights the correct one", () => {
    // The point of the feedback: a wrong answer must reveal the right one.
    expect(optionStateFor(wrong, "b", true)).toBe("wrong");
    expect(optionStateFor(right, "b", true)).toBe("correct");
  });

  test("leaves options the member did not pick neutral", () => {
    expect(optionStateFor(other, "b", true)).toBe("idle");
  });

  test("giving up reveals the key without marking anything wrong", () => {
    // "Lihat jawaban" sets showKey with no selection: nothing should read as wrong.
    expect(optionStateFor(right, null, true)).toBe("correct");
    expect(optionStateFor(wrong, null, true)).toBe("idle");
    expect(optionStateFor(other, null, true)).toBe("idle");
  });
});

describe("tally", () => {
  test("counts answered and correct separately", () => {
    expect(tally({})).toEqual({ answered: 0, correct: 0 });
    expect(tally({ q1: true, q2: false, q3: true })).toEqual({ answered: 3, correct: 2 });
  });

  test("a cleared answer is not counted at all", () => {
    // "Coba lagi" deletes the key rather than storing false, so retrying a
    // question must not leave a wrong answer behind in the score.
    const answers: Record<string, boolean> = { q1: true, q2: false };
    delete answers.q2;
    expect(tally(answers)).toEqual({ answered: 1, correct: 1 });
  });
});
