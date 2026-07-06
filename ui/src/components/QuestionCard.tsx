import { useState } from 'react';
import { store, useStore } from '../store';
import type { QuestionItem } from '../wire';

interface Props {
  clientId: string;
  requestId: string;
  questions: QuestionItem[];
}

/**
 * Interactive card for a relayed AskUserQuestion. Single-select questions
 * answer on click; multi-select (or multi-question) cards collect choices
 * and submit once. Answered cards render inert — the answer travels via
 * `question_response` and the session's reply arrives as normal frames.
 */
export function QuestionCard({ clientId, requestId, questions }: Props) {
  const answered = useStore((s) => s.answeredQuestions[requestId]);
  const needsSubmit = questions.length > 1 || questions.some((q) => q.multiSelect);
  // picked[qi] = set of chosen option labels for question qi.
  const [picked, setPicked] = useState<Record<number, string[]>>({});

  const isAnswered = answered !== undefined;

  const submit = (override?: Record<number, string[]>): void => {
    const chosen = override ?? picked;
    const answers = questions.map((q, i) => ({
      question: q.question,
      ...(q.header !== undefined ? { header: q.header } : {}),
      labels: chosen[i] ?? [],
    }));
    store.answerQuestion(clientId, requestId, answers);
  };

  const onOptionClick = (qi: number, q: QuestionItem, label: string): void => {
    if (store.getState().answeredQuestions[requestId] !== undefined) return;
    if (q.multiSelect) {
      setPicked((prev) => {
        const cur = new Set(prev[qi] ?? []);
        cur.has(label) ? cur.delete(label) : cur.add(label);
        return { ...prev, [qi]: [...cur] };
      });
      return;
    }
    // single-select
    if (needsSubmit) {
      setPicked((prev) => ({ ...prev, [qi]: [label] }));
    } else {
      // Single question, single-select: answer immediately.
      submit({ [qi]: [label] });
    }
  };

  return (
    <div className={`msg question${isAnswered ? ' answered' : ''}`}>
      <div className="role">Question</div>
      {questions.map((q, qi) => {
        const sel = new Set(picked[qi] ?? []);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
          <div className="q-block" key={qi}>
            {q.header ? <div className="q-header">{q.header}</div> : null}
            <div className="q-text">{q.question}</div>
            <div className="q-opts">
              {q.options.map((opt, j) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
                  key={j}
                  type="button"
                  className={`q-opt${sel.has(opt.label) ? ' picked' : ''}`}
                  disabled={isAnswered}
                  onClick={() => onOptionClick(qi, q, opt.label)}
                >
                  <span className="q-opt-label">{opt.label}</span>
                  {opt.description ? <span className="q-opt-desc">{opt.description}</span> : null}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      {isAnswered ? (
        <div className="q-answered">answered: {answered}</div>
      ) : needsSubmit ? (
        <button type="button" className="q-submit" onClick={() => submit()}>
          Send answer
        </button>
      ) : null}
    </div>
  );
}
