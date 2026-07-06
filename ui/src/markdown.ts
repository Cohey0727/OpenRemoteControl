import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Tags that must never survive into the DOM, and the attribute patterns
 * that carry script. Model output (assistant / thinking text) is
 * attacker-influenced — it can echo file/tool/web content — so its
 * rendered HTML is sanitized before it touches innerHTML. Without this,
 * a `<img src=x onerror=…>` in a reply would run script on the relay's
 * own origin and could open its own /ws to drive the agent and
 * auto-approve permissions. No external dependency: we reuse the
 * browser's own parser.
 */
const UNSAFE_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'LINK',
  'META',
  'BASE',
  'FORM',
]);

function sanitizeHtml(dirty: string): string {
  const doc = new DOMParser().parseFromString(dirty, 'text/html');
  const els: Element[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) els.push(walker.currentNode as Element);
  for (const el of els) {
    if (UNSAFE_TAGS.has(el.tagName)) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href') &&
        /^\s*(javascript|data|vbscript):/i.test(attr.value)
      ) {
        el.removeAttribute(attr.name);
      } else if (name === 'srcdoc' || name === 'style') {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.body.innerHTML;
}

/** Parse + sanitize model markdown to an HTML string safe for innerHTML. */
export function renderMarkdown(text: string): string {
  return sanitizeHtml(marked.parse(text, { async: false }) as string);
}
