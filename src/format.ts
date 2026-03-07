/**
 * Convert GitHub-style markdown to Telegram-compatible HTML.
 * Telegram HTML supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>.
 * No headers — we convert # to bold.
 */

export function markdownToTelegramHtml(md: string): string {
  const codeBlocks: string[] = [];
  let html = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    const block = lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(block);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${inlineCodes.length - 1}\x00`;
  });

  html = escapeHtml(html);

  html = html.replace(/^#{1,6}\s+(.+)$/gm, "\n<b>$1</b>\n");
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");
  html = html.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "<i>$1</i>");
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");
  html = html.replace(
    /\[(.+?)\]\((.+?)\)/g,
    '<a href="$2">$1</a>',
  );

  html = html.replace(/\x00INLINE(\d+)\x00/g, (_m, i) => inlineCodes[Number(i)]);
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, i) => codeBlocks[Number(i)]);
  html = html.replace(/\n{3,}/g, "\n\n");

  return html.trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
