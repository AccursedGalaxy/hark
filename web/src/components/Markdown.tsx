import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { splitArtifacts } from "../lib/htmlArtifact";
import { HtmlArtifact } from "./HtmlArtifact";

// Configure once. GFM gives tables/strikethrough; breaks=true so a single
// newline becomes <br> (chat-message style, not document style).
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Wrap every <table> in a horizontally-scrollable container. A bare wide
// table pushes its parent's width out (table layout is not constrained by
// the parent's inline-size); on a phone that turns the whole transcript
// into a horizontally-pannable surface, which captures swipes and feels
// broken. The wrapper has `overflow-x: auto` so tables that exceed the
// viewport scroll within their own row instead.
//
// We do this via the postprocess hook (string-rewrite of the rendered
// HTML) rather than a renderer override — marked v18's table renderer
// dispatches to `this.parser.parseInline` for cells, and wrapping with
// `.bind()` drops that context. The output is still sanitised below.
//
// CSS for `.md-table-wrap` lives in markdown.css.
marked.use({
  hooks: {
    postprocess(html: string) {
      return html
        .replace(/<table>/g, '<div class="md-table-wrap"><table>')
        .replace(/<\/table>/g, "</table></div>");
    },
  },
});

// Open external links in a new tab; DOMPurify will keep the attributes.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function MarkdownChunk({
  source,
  tight = false,
}: {
  source: string;
  tight?: boolean;
}) {
  const html = useMemo(() => {
    // `marked.parse` is sync when not given a callback. Cast to string.
    const raw = marked.parse(source) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [source]);

  return (
    <div
      className={`md${tight ? " md-tight" : ""}`}
      // Output is sanitised by DOMPurify above.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function Markdown({
  source,
  tight = false,
}: {
  source: string;
  tight?: boolean;
}) {
  // hark:html fenced blocks render as inline HTML artifacts; everything
  // else goes through the normal markdown path. Segment indices are stable
  // for a given source, so they're safe as keys.
  const segments = useMemo(() => splitArtifacts(source), [source]);

  if (segments.length === 1 && segments[0].kind === "md") {
    return <MarkdownChunk source={source} tight={tight} />;
  }
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "md" ? (
          <MarkdownChunk key={i} source={s.text} tight={tight} />
        ) : (
          <HtmlArtifact key={i} html={s.html} closed={s.closed} />
        ),
      )}
    </>
  );
}
