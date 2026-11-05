import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, messageText } from "../src/lib/markdown.ts";

test("escapes raw HTML and script payloads", () => {
  const html = markdownToHtml('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renders bold, inline code and links as text", () => {
  const html = markdownToHtml("**LONG** with `64,250` [docs](https://example.com/a?b=1)");
  assert.ok(html.includes("<strong>LONG</strong>"));
  assert.ok(html.includes("<code>64,250</code>"));
  assert.ok(html.includes("docs (https://example.com/a?b=1)"));
  assert.ok(!html.includes("<a href"));
});

test("fenced code is escaped and keeps its language label", () => {
  const html = markdownToHtml("```json\n{\"a\": 1}\n```");
  assert.ok(html.includes('class="md-code-lang">json'));
  assert.ok(html.includes("{&quot;a&quot;: 1}") || html.includes("{&#34;a&#34;: 1}") || html.includes("{&quot;a&quot;"));
});

test("tables render without overflowing markup", () => {
  const html = markdownToHtml("| Level | Price |\n| --- | --- |\n| TP | 66000 |");
  assert.ok(html.includes("<table"));
  assert.ok(html.includes("<th>Level</th>"));
  assert.ok(html.includes("<td>66000</td>"));
});

test("lists, headings and blockquotes render", () => {
  const html = markdownToHtml("### Verdict\n- one\n- two\n\n> risk note");
  assert.ok(html.includes("<h5>Verdict</h5>"));
  assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
  assert.ok(html.includes("<blockquote>risk note</blockquote>"));
});

test("an unfinished fence during streaming does not throw", () => {
  const html = markdownToHtml("analysis\n```json\n{\"action\":");
  assert.ok(html.includes("analysis"));
  assert.ok(html.includes("md-code"));
});

test("messageText flattens text parts and ignores thinking/tool calls", () => {
  assert.equal(messageText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Hi" }] }), "Hi");
  assert.equal(messageText({ role: "assistant", content: "plain" }), "plain");
  assert.equal(messageText(null), "");
});
