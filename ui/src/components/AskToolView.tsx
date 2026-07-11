import type { QuestionItem } from '../wire';

/** Parse an AskUserQuestion tool-call input into its questions, or null
 *  if it isn't the shape we can render (caller falls back to raw JSON). */
export function parseAskQuestions(inputJson: string): QuestionItem[] | null {
  try {
    const parsed = JSON.parse(inputJson) as { questions?: QuestionItem[] };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
    return parsed.questions;
  } catch {
    return null;
  }
}

/**
 * Display-only rendering of the AskUserQuestion TOOL CALL from the
 * transcript: the question previews in the collapsed summary and options
 * render as inert rows, never raw JSON. The interactive card is a separate
 * `question` frame (see QuestionCard).
 */
export function AskToolView({ questions }: { questions: QuestionItem[] }) {
  const preview = questions[0]?.question ?? '';
  return (
    <details className="msg tool ask">
      <summary>
        <span className="name">AskUserQuestion</span>
        <span className="ask-preview">{preview}</span>
      </summary>
      <div className="ask-body">
        {questions.map((q, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
          <div className="q-block" key={i}>
            {q.header ? <div className="q-header">{q.header}</div> : null}
            <div className="q-text">{q.question}</div>
            <div className="q-opts">
              {q.options.map((opt, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
                <div className="q-opt ro" key={j}>
                  <span className="q-opt-label">{opt.label}</span>
                  {opt.description ? <span className="q-opt-desc">{opt.description}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
