/**
 * Makes untrusted text (model output, file paths, evidence) safe to post as a GitLab/GitHub comment.
 *
 * Threats handled:
 *  - Markdown/HTML structure injection → escape markdown control characters, collapse newlines.
 *  - Mentions (`@all`, `@group`) → mass notifications → a zero-width joiner breaks the mention.
 *  - GitLab quick actions: a comment line starting with `/` (e.g. `/merge`, `/approve`, `/assign`)
 *    is EXECUTED as the bot user. Every line outside code fences that starts with `/` is neutralised.
 */
const ZWJ = '‍';

export function escapeInline(text: string): string {
  return text
    .replace(/\r?\n/g, ' ')
    .replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&')
    .replace(/@/g, `@${ZWJ}`);
}

/** Fenced code block whose fence cannot be closed by the content. */
export function codeFence(text: string): string {
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return `${fence}\n${text.replace(/@/g, `@${ZWJ}`)}\n${fence}`;
}

/** Final pass over a complete comment body: neutralise quick-action lines outside fences. */
export function neutralizeQuickActions(body: string): string {
  let fence: string | null = null;
  return body
    .split('\n')
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch?.[1]) {
        if (fence === null) fence = fenceMatch[1];
        else if (fenceMatch[1].startsWith(fence)) fence = null;
        return line;
      }
      if (fence === null && /^\s*\//.test(line)) return `${ZWJ}${line}`;
      return line;
    })
    .join('\n');
}
