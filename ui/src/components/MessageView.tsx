import { formatJson } from '../format';
import type { UiMessage } from '../wire';
import { AskToolView, parseAskQuestions } from './AskToolView';
import { Markdown } from './Markdown';
import { QuestionCard } from './QuestionCard';

export function MessageView({ clientId, message }: { clientId: string; message: UiMessage }) {
  switch (message.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="role">You</div>
          <div className="body">{message.text}</div>
        </div>
      );
    case 'assistant_text':
      return (
        <div className="msg text">
          <div className="role">Assistant</div>
          <Markdown text={message.text} />
        </div>
      );
    case 'thinking':
      return (
        <details className="msg thinking">
          <summary>
            <span className="role">Thinking</span>
          </summary>
          <Markdown text={message.text} />
        </details>
      );
    case 'tool_use': {
      if (message.tool === 'AskUserQuestion') {
        const questions = parseAskQuestions(message.input);
        if (questions) return <AskToolView questions={questions} />;
      }
      return (
        <details className="msg tool_use">
          <summary>
            <span className="name">{message.tool}</span>
          </summary>
          <pre className="body">{formatJson(message.input)}</pre>
        </details>
      );
    }
    case 'tool_result':
      return (
        <details className="msg tool_result">
          <summary>
            <span className="name">result</span>
          </summary>
          <pre className="body">{message.output}</pre>
        </details>
      );
    case 'question':
      return (
        <QuestionCard
          clientId={clientId}
          requestId={message.requestId}
          questions={message.questions}
        />
      );
    case 'system':
      return (
        <div className="msg system">
          <div className="body">{message.text}</div>
        </div>
      );
    case 'divider':
      return <div className="msg divider">{message.text}</div>;
    case 'error':
      return (
        <div className="msg error">
          <div className="role">Error</div>
          <div className="body">{message.text}</div>
        </div>
      );
  }
}
