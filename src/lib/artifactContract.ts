// The hark:html artifact contract — the paragraph of context injected into
// every Claude Code session on this host (via the SessionStart hook, which
// curls GET /api/artifact-contract and whose stdout Claude Code adds to the
// session's context). This is how sessions LEARN the format; the rendering
// half lives in web/src/lib/htmlArtifact.ts + components/HtmlArtifact.tsx.
//
// Keep it short: it is paid for in tokens by every session on the machine.
export const ARTIFACT_CONTRACT = `# hark rich output (hark:html artifacts)

Sessions on this host are viewable in hark, a mobile/web UI that renders your
replies as markdown. For output where layout or graphics genuinely beat prose
— metric tables, bar/spark charts, status cards, small reports — you may emit
a fenced code block tagged \`hark:html\`; hark renders its body as sanitized
inline HTML.

Rules:
- Self-contained HTML only: inline CSS (style attributes or one <style> block)
  and inline SVG for charts. No scripts (stripped).
- No external resources: img src / CSS url() must be data: URIs or
  same-origin paths — external URLs are stripped by the sanitizer.
- Prefer hark's theme variables (--fg-1, --fg-2, --line-strong, --radius-md,
  --accent, --mono) over hardcoded colors so artifacts match the UI.
- In a terminal the block degrades to plain code, so keep surrounding text
  meaningful on its own; use artifacts to enhance an answer, not replace it.
- Use sparingly — ordinary prose and markdown stay markdown.
`;
