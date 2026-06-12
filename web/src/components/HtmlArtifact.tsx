import { useMemo } from "react";
import DOMPurify from "dompurify";
import { isAllowedResourceUrl, scrubCssUrls } from "../lib/htmlArtifact";

// Renders a hark:html artifact block inline in the transcript. v1 is
// display-only: no scripts, no iframes — sanitized DOM in the normal flow,
// so scroll-anchoring, theming (CSS custom properties), and windowed
// rendering all apply unchanged.
//
// A SEPARATE DOMPurify instance: Markdown.tsx hangs its own hooks off the
// shared default instance, and our resource-URL hooks must not start
// stripping external images from ordinary markdown (or vice versa).
const purifier = typeof window === "undefined" ? null : DOMPurify(window);

if (purifier) {
  purifier.addHook("afterSanitizeAttributes", (node) => {
    // Police every attribute the browser fetches at render time — see the
    // policy rationale in lib/htmlArtifact.ts. <a href> is exempt
    // (navigation needs a tap) but gets the same new-tab treatment as
    // markdown links.
    for (const attr of ["src", "poster", "xlink:href"]) {
      const v = node.getAttribute(attr);
      if (v !== null && !isAllowedResourceUrl(v)) node.removeAttribute(attr);
    }
    // A media element whose src was stripped renders as a broken-image
    // glyph — drop it outright rather than leave visual debris.
    if (
      (node.tagName === "IMG" || node.tagName === "VIDEO") &&
      !node.getAttribute("src")
    ) {
      node.remove();
    }
    const href = node.getAttribute("href");
    if (href !== null) {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      } else if (!isAllowedResourceUrl(href)) {
        node.removeAttribute("href");
      }
    }
    const style = node.getAttribute("style");
    if (style !== null) node.setAttribute("style", scrubCssUrls(style));
  });
  purifier.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") {
      node.textContent = scrubCssUrls(node.textContent ?? "");
    }
  });
}

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  // <style> + style= power the "better than markdown" layout; their url()s
  // are scrubbed by the hooks above. srcset is multi-URL (annoying to
  // police) and pointless for self-contained artifacts — forbid outright.
  ADD_TAGS: ["style"],
  ADD_ATTR: ["style"],
  FORBID_ATTR: ["srcset"],
};

export function HtmlArtifact({
  html,
  closed,
}: {
  html: string;
  closed: boolean;
}) {
  const safe = useMemo(
    () => (closed && purifier ? purifier.sanitize(html, SANITIZE_CONFIG) : ""),
    [html, closed],
  );

  // Still streaming: the fence hasn't closed, so the HTML is a prefix —
  // rendering it would flash half-built layout on every delta.
  if (!closed) {
    return (
      <div className="html-artifact html-artifact-streaming" aria-busy="true">
        Rendering view…
      </div>
    );
  }
  return (
    <div
      className="html-artifact"
      // Sanitized above; resource URLs restricted to data:/same-origin.
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  );
}
