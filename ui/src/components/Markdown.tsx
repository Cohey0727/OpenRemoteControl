import { renderMarkdown } from '../markdown';

/** Assistant / thinking markdown, sanitized before it touches the DOM
 *  (see renderMarkdown → sanitizeHtml). */
export function Markdown({ text }: { text: string }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized in renderMarkdown
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
