import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

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

export function Markdown({
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
