/**
 * Pure grading logic for the quiz panel, kept out of the component so it can be
 * checked without a DOM. QuizPanel only maps these results onto colours.
 */

export type OptionState = "idle" | "correct" | "wrong";

/**
 * How one option should render.
 *
 * Before the key is shown everything stays neutral. Once it is shown, the
 * correct option is always highlighted — including when the member picked
 * something else — so a wrong answer still teaches the right one.
 */
export function optionStateFor(
  option: { id: string; isCorrect: boolean },
  selected: string | null,
  showKey: boolean,
): OptionState {
  if (!showKey) return "idle";
  if (option.isCorrect) return "correct";
  if (option.id === selected) return "wrong";
  return "idle";
}

/** Running score. `answers` holds only questions the member actually answered. */
export function tally(answers: Record<string, boolean>): { answered: number; correct: number } {
  const values = Object.values(answers);
  return { answered: values.length, correct: values.filter(Boolean).length };
}
