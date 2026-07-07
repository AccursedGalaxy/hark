// The hark:html artifact contract — the paragraph of context injected into
// every Claude Code session on this host (via the SessionStart hook, which
// curls GET /api/artifact-contract and whose stdout Claude Code adds to the
// session's context). This is how sessions LEARN the format; the rendering
// half lives in web/src/lib/htmlArtifact.ts + components/HtmlArtifact.tsx.
//
// Keep it short: it is paid for in tokens by every session on the machine.
export const ARTIFACT_CONTRACT = `# hark rich output (hark:html artifacts)

Sessions on this host are also viewed in hark, a mobile/web UI that renders
replies as markdown. Your replies are read in BOTH places, so structured
output must stay readable in both: GFM markdown — tables, lists, headings,
code blocks — renders well in the terminal AND in hark, and is the default
for ALL structured output (metric tables, checkpoints, reports, comparisons).

Only when actual graphics beat anything markdown can express — an inline SVG
bar/spark/line chart, a color-coded status strip — may you emit a fenced code
block tagged \`hark:html\`; hark renders its body as sanitized inline HTML,
but every other viewer (the terminal included) sees raw HTML source. So:
- The artifact is an enhancement, never the answer: state the numbers and the
  takeaway in prose/markdown first. Text, tables, or figures that appear ONLY
  inside the artifact are invisible to terminal readers.
- Keep it small (one chart, not a report) and rare — most replies need none.
- Self-contained HTML only: inline CSS (style attributes or one <style>
  block) and inline SVG. No scripts (stripped). No external resources:
  img src / CSS url() must be data: URIs or same-origin paths.
- Prefer hark's theme variables (--fg-1, --fg-2, --line-strong, --radius-md,
  --accent, --mono) over hardcoded colors so artifacts match the UI.
`;
