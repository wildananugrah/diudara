import { useCallback, useEffect, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faPen, faPlus, faTrash, faXmark } from "@fortawesome/free-solid-svg-icons";
import {
  api,
  type ApiQuestionInput,
  type ApiQuizFormat,
  type ApiQuizOption,
  type ApiQuizQuestion,
} from "../../lib/api";
import { useApi } from "../../lib/useApi";
import ConfirmDialog from "../ui/ConfirmDialog";
import { optionStateFor, tally, type OptionState } from "./quizGrading";

type OptionDraft = { text: string; isCorrect: boolean };

const TRUE_FALSE_OPTIONS: OptionDraft[] = [
  { text: "Benar", isCorrect: true },
  { text: "Salah", isCorrect: false },
];

const FORMAT_LABEL: Record<ApiQuizFormat, string> = {
  multiple_choice: "Pilihan ganda",
  true_false: "Benar / Salah",
};

/**
 * Editor for one question. Options live entirely in local state and are sent as
 * a complete set — the server replaces them wholesale, so there is no per-option
 * create/delete to keep in sync.
 */
function QuestionForm({ initial, busy, onSubmit, onCancel }: {
  initial?: ApiQuizQuestion;
  busy: boolean;
  onSubmit: (value: ApiQuestionInput) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [format, setFormat] = useState<ApiQuizFormat>(initial?.format ?? "multiple_choice");
  const [explanation, setExplanation] = useState(initial?.explanation ?? "");
  const [options, setOptions] = useState<OptionDraft[]>(
    initial?.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect }))
      ?? [{ text: "", isCorrect: true }, { text: "", isCorrect: false }],
  );

  /** Benar/Salah is fixed, so switching format swaps the option set entirely. */
  const changeFormat = (next: ApiQuizFormat) => {
    setFormat(next);
    setOptions(next === "true_false"
      ? TRUE_FALSE_OPTIONS.map((o) => ({ ...o }))
      : [{ text: "", isCorrect: true }, { text: "", isCorrect: false }]);
  };

  // Exactly one correct answer, so marking one clears the rest.
  const markCorrect = (index: number) =>
    setOptions((prev) => prev.map((o, i) => ({ ...o, isCorrect: i === index })));

  const setText = (index: number, text: string) =>
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, text } : o)));

  const addOption = () => setOptions((prev) => [...prev, { text: "", isCorrect: false }]);

  const removeOption = (index: number) =>
    setOptions((prev) => {
      const next = prev.filter((_, i) => i !== index);
      // Never leave a question with no correct answer — the server would reject it.
      if (!next.some((o) => o.isCorrect) && next[0]) next[0].isCorrect = true;
      return next;
    });

  const filled = options.filter((o) => o.text.trim());
  const canSave = prompt.trim() && filled.length >= 2 && filled.some((o) => o.isCorrect);

  return (
    <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <textarea
        className="input" autoFocus rows={2} placeholder="Tulis pertanyaan…"
        value={prompt} onChange={(e) => setPrompt(e.target.value)}
        style={{ fontSize: 13.5, resize: "vertical" }}
      />

      <select
        className="input" value={format}
        onChange={(e) => changeFormat(e.target.value as ApiQuizFormat)}
        style={{ fontSize: 13 }}
      >
        {(Object.keys(FORMAT_LABEL) as ApiQuizFormat[]).map((f) => (
          <option key={f} value={f}>{FORMAT_LABEL[f]}</option>
        ))}
      </select>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((option, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="radio" name="correct" checked={option.isCorrect}
              onChange={() => markCorrect(i)} title="Tandai sebagai jawaban benar"
              style={{ flexShrink: 0, accentColor: "var(--langit)" }}
            />
            <input
              className="input" value={option.text}
              placeholder={`Pilihan ${i + 1}`}
              // Benar/Salah are fixed labels; only their correctness is editable.
              readOnly={format === "true_false"}
              onChange={(e) => setText(i, e.target.value)}
              style={{ flex: 1, fontSize: 13 }}
            />
            {format === "multiple_choice" && options.length > 2 && (
              <button
                className="btn btn-ghost btn-sm" onClick={() => removeOption(i)}
                title="Hapus pilihan" style={{ color: "var(--merah-senja)", flexShrink: 0 }}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            )}
          </div>
        ))}
        {format === "multiple_choice" && (
          <button className="btn btn-ghost btn-sm" onClick={addOption} style={{ alignSelf: "flex-start" }}>
            <FontAwesomeIcon icon={faPlus} /> Pilihan
          </button>
        )}
      </div>

      <input
        className="input" placeholder="Pembahasan (opsional)"
        value={explanation} onChange={(e) => setExplanation(e.target.value)}
        style={{ fontSize: 13 }}
      />

      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn btn-primary btn-sm" disabled={busy || !canSave}
          onClick={() => onSubmit({
            prompt: prompt.trim(), format,
            explanation: explanation.trim() || null,
            options: filled.map((o) => ({ text: o.text.trim(), isCorrect: o.isCorrect })),
          })}
        >
          Simpan soal
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>Batal</button>
      </div>
    </div>
  );
}

/** Colour per option once the key is visible; before that everything stays neutral. */
const OPTION_STYLE: Record<OptionState, { bg: string; fg: string; border: string }> = {
  idle: { bg: "transparent", fg: "var(--ink-700)", border: "var(--ink-150)" },
  correct: { bg: "var(--success-bg)", fg: "#2e6248", border: "var(--hijau-lepas)" },
  wrong: { bg: "var(--danger-bg)", fg: "var(--merah-senja)", border: "var(--merah-senja)" },
};

/**
 * One question a member can actually answer. Picking an option locks the card
 * and marks it right or wrong immediately; the correct option is highlighted
 * either way so a wrong answer still teaches something.
 */
function QuestionCard({ question, index, isAdmin, busy, onEdit, onDelete, onAnswer }: {
  question: ApiQuizQuestion;
  index: number;
  isAdmin: boolean;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** null clears a previous answer — retrying must not count as a wrong one. */
  onAnswer: (questionId: string, isCorrect: boolean | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const answered = selected !== null;
  // Giving up shows the key too, but is not recorded as an answer.
  const showKey = answered || revealed;
  const gotItRight = answered && question.options.some((o) => o.id === selected && o.isCorrect);

  const pick = (option: ApiQuizOption) => {
    if (showKey) return;
    setSelected(option.id);
    onAnswer(question.id, option.isCorrect);
  };

  const reset = () => { setSelected(null); setRevealed(false); onAnswer(question.id, null); };

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 }}>
        <p style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.45 }}>
          <span style={{ color: "var(--ink-500)", marginRight: 6 }}>{index + 1}.</span>
          {question.prompt}
        </p>
        <span className="badge badge-neutral" style={{ flexShrink: 0 }}>{FORMAT_LABEL[question.format]}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
        {question.options.map((option) => {
          const state: OptionState = optionStateFor(option, selected, showKey);
          const style = OPTION_STYLE[state];
          return (
            <button
              key={option.id}
              onClick={() => pick(option)}
              disabled={showKey}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 9,
                fontSize: 13, textAlign: "left", width: "100%",
                background: style.bg, color: style.fg,
                border: `1px solid ${style.border}`,
                fontWeight: state === "idle" ? 500 : 700,
                cursor: showKey ? "default" : "pointer",
              }}
            >
              <span style={{ width: 14, flexShrink: 0 }}>
                {state === "correct" && <FontAwesomeIcon icon={faCheck} />}
                {state === "wrong" && <FontAwesomeIcon icon={faXmark} />}
              </span>
              {option.text}
            </button>
          );
        })}
      </div>

      {answered && (
        <p
          style={{
            fontSize: 13, fontWeight: 700, marginBottom: 8,
            color: gotItRight ? "#2e6248" : "var(--merah-senja)",
          }}
        >
          <FontAwesomeIcon icon={gotItRight ? faCheck : faXmark} />{" "}
          {gotItRight ? "Jawaban kamu benar." : "Belum tepat — jawaban yang benar ditandai hijau."}
        </p>
      )}

      {showKey && question.explanation && (
        <p style={{ fontSize: 12.5, color: "var(--ink-500)", lineHeight: 1.5, marginBottom: 10 }}>
          {question.explanation}
        </p>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        {showKey ? (
          <button className="btn btn-ghost btn-sm" onClick={reset}>Coba lagi</button>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setRevealed(true)}>Lihat jawaban</button>
        )}
        {isAdmin && (
          <>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onEdit}>
              <FontAwesomeIcon icon={faPen} />
            </button>
            <button
              className="btn btn-ghost btn-sm" disabled={busy} onClick={onDelete}
              style={{ color: "var(--merah-senja)" }}
            >
              <FontAwesomeIcon icon={faTrash} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The quiz body of a materi item. Creators author questions here; members read
 * them and can reveal the key. Nothing is submitted or scored yet.
 */
export default function QuizPanel({ itemId, isAdmin }: { itemId: string; isAdmin: boolean }) {
  const questionsQ = useApi(useCallback(() => api.quiz.list(itemId), [itemId]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // Answers live only in this session — nothing is submitted or stored yet.
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  // Bumping this remounts every card, which is how "Ulangi semua" clears the
  // selection each card holds internally.
  const [round, setRound] = useState(0);
  const [removingQuestion, setRemovingQuestion] = useState<ApiQuizQuestion | null>(null);

  // Switching to another quiz item must not leave the previous item's form open
  // or carry the previous quiz's answers over.
  useEffect(() => { setAdding(false); setEditing(null); setError(null); setAnswers({}); setRound((r) => r + 1); }, [itemId]);

  const recordAnswer = (questionId: string, isCorrect: boolean | null) =>
    setAnswers((prev) => {
      if (isCorrect === null) {
        const { [questionId]: _cleared, ...rest } = prev;
        return rest;
      }
      return { ...prev, [questionId]: isCorrect };
    });

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
      questionsQ.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  const questions = questionsQ.data ?? [];
  const { answered: answeredCount, correct: correctCount } = tally(answers);
  const restartAll = () => { setAnswers({}); setRound((r) => r + 1); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 18 }}>
      {questionsQ.loading && <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Memuat soal…</p>}
      {questionsQ.error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{questionsQ.error}</p>}
      {error && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{error}</p>}

      {answeredCount > 0 && (
        <div
          className="card"
          style={{
            padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 10, fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 600 }}>
            Benar {correctCount} dari {answeredCount} dijawab
            <span style={{ color: "var(--ink-500)", fontWeight: 400 }}> · {questions.length} soal</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={restartAll}>Ulangi semua</button>
        </div>
      )}

      {!questionsQ.loading && !questionsQ.error && questions.length === 0 && !adding && (
        <p style={{ fontSize: 13, color: "var(--ink-500)" }}>
          {isAdmin ? "Belum ada soal. Tambah soal pertama di bawah." : "Belum ada soal di kuis ini."}
        </p>
      )}

      {questions.map((question, i) => (
        editing === question.id ? (
          <QuestionForm
            key={question.id} initial={question} busy={busy}
            onSubmit={(value) => run(async () => {
              await api.quiz.updateQuestion(question.id, value);
              setEditing(null);
            }, "Gagal menyimpan soal")}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <QuestionCard
            key={`${question.id}-${round}`} question={question} index={i} isAdmin={isAdmin} busy={busy}
            onAnswer={recordAnswer}
            onEdit={() => { setEditing(question.id); setAdding(false); }}
            onDelete={() => setRemovingQuestion(question)}
          />
        )
      ))}

      {isAdmin && (adding ? (
        <QuestionForm
          busy={busy}
          onSubmit={(value) => run(async () => {
            await api.quiz.createQuestion(itemId, value);
            setAdding(false);
          }, "Gagal menambah soal")}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          className="btn btn-secondary btn-sm" disabled={busy}
          onClick={() => { setAdding(true); setEditing(null); }}
          style={{ alignSelf: "flex-start" }}
        >
          <FontAwesomeIcon icon={faPlus} /> Tambah soal
        </button>
      ))}

      {removingQuestion && (
        <ConfirmDialog
          title="Hapus soal ini?"
          subtitle={FORMAT_LABEL[removingQuestion.format]}
          busy={busy}
          onCancel={() => setRemovingQuestion(null)}
          onConfirm={() => void run(async () => {
            await api.quiz.removeQuestion(removingQuestion.id);
            setRemovingQuestion(null);
          }, "Gagal menghapus soal")}
        >
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{removingQuestion.prompt}</p>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
            Soal ini beserta semua pilihan jawabannya akan dihapus permanen.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
