/**
 * Small, dependency-free Markdown renderer for the narrow AI panel.
 *
 * Security: every input character is HTML-escaped before any formatting tag is
 * inserted. Raw HTML is never passed through, links are rendered as text (not
 * anchors) so the WebView cannot be navigated away, and code blocks are escaped
 * separately. The output is safe to assign with innerHTML.
 *
 * Supported: headings, bold, italic, strikethrough, inline code, fenced code,
 * ordered/unordered lists, blockquotes, tables, horizontal rules and paragraphs.
 */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inline(raw: string): string {
  // Protect code spans first: their content must not receive emphasis tags.
  const codes: string[] = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => `${label} (${url})`,
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\u0000C(\d+)\u0000/g, (_match, index: string) => codes[Number(index)] ?? "");
  return text;
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s:|-]*$/.test(line) && line.includes("-") && line.includes("|");
}

function renderTable(lines: string[], start: number): { html: string; next: number } {
  const header = splitRow(lines[start]);
  const body: string[][] = [];
  let index = start + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
    body.push(splitRow(lines[index]));
    index += 1;
  }
  const headHtml = header.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("");
  return {
    html: `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    next: index,
  };
}

function renderCode(code: string, language: string): string {
  const lang = language.trim().slice(0, 24);
  const label = lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : "";
  return `<pre class="md-code">${label}<code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
}

export function markdownToHtml(source: string): string {
  if (!source) return "";
  const lines = source.replace(/\r\n?/g, "\n").replace(CONTROL, "").split("\n");
  const out: string[] = [];
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map((line) => inline(line)).join("<br>")}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const language = trimmed.slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1; // closing fence
      out.push(renderCode(code.join("\n"), language));
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      index += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      out.push("<hr>");
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quote.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote>${quote.map((line) => inline(line)).join("<br>")}</blockquote>`);
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      const table = renderTable(lines, index);
      out.push(table.html);
      index = table.next;
      continue;
    }

    const bullet = /^\s*([-*+])\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*([-*+])\s+(.*)$/.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${inline(match[2])}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${inline(match[1])}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return out.join("");
}

/** Flatten a Pi AgentMessage into the text the panel should show. */
export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as { type?: string; text?: string };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("");
}
