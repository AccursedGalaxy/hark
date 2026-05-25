import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Configure once. GFM gives tables/strikethrough; breaks=true so a single
// newline becomes <br> (chat-message style, not document style).
marked.setOptions({
  gfm: true,
  breaks: true,
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
