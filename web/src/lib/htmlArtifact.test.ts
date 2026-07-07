import { describe, expect, it } from "vitest";
import {
  isAllowedResourceUrl,
  isClosedFence,
  scrubCssUrls,
  splitArtifacts,
} from "./htmlArtifact";

describe("splitArtifacts", () => {
  it("plain markdown is a single md segment", () => {
    const src = "# hi\n\nsome **text**\n";
    expect(splitArtifacts(src)).toEqual([{ kind: "md", text: src }]);
  });

  it("bare ```html stays markdown (rendering is opt-in)", () => {
    const src = "look:\n\n```html\n<b>code sample</b>\n```\n";
    expect(splitArtifacts(src)).toEqual([{ kind: "md", text: src }]);
  });

  it("extracts a closed hark:html block between markdown runs", () => {
    const src =
      "before\n\n```hark:html\n<div class=\"card\">hi</div>\n```\n\nafter\n";
    const segs = splitArtifacts(src);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: "md", text: "before\n\n" });
    expect(segs[1]).toEqual({
      kind: "artifact",
      html: '<div class="card">hi</div>',
      closed: true,
    });
    expect(segs[2]).toEqual({ kind: "md", text: "\n\nafter\n" });
  });

  it("artifact-only source yields a single artifact segment", () => {
    const segs = splitArtifacts("```hark:html\n<p>x</p>\n```");
    expect(segs).toEqual([{ kind: "artifact", html: "<p>x</p>", closed: true }]);
  });

  it("an unclosed fence (still streaming) is closed:false", () => {
    const segs = splitArtifacts("text\n\n```hark:html\n<div>partial…");
    expect(segs[1]).toMatchObject({ kind: "artifact", closed: false });
  });

  it("a hark:html fence quoted inside a longer outer fence stays markdown", () => {
    const src =
      "example:\n\n````md\n```hark:html\n<p>not rendered</p>\n```\n````\n";
    expect(splitArtifacts(src)).toEqual([{ kind: "md", text: src }]);
  });

  it("tag matching is case-insensitive and tolerates extra info words", () => {
    const segs = splitArtifacts("```HARK:HTML chart\n<svg></svg>\n```");
    expect(segs).toEqual([
      { kind: "artifact", html: "<svg></svg>", closed: true },
    ]);
  });
});

describe("isClosedFence", () => {
  it("closed backtick fence", () => {
    expect(isClosedFence("```hark:html\n<p>x</p>\n```")).toBe(true);
  });
  it("closed with trailing newline", () => {
    expect(isClosedFence("```hark:html\n<p>x</p>\n```\n")).toBe(true);
  });
  it("unclosed fence", () => {
    expect(isClosedFence("```hark:html\n<p>x</p>")).toBe(false);
  });
  it("a shorter run of backticks does not close a longer opener", () => {
    expect(isClosedFence("````hark:html\n<p>```</p>")).toBe(false);
  });
  it("closing fence may be longer than the opener", () => {
    expect(isClosedFence("```hark:html\n<p>x</p>\n`````")).toBe(true);
  });
  it("tilde fences close with tildes, not backticks", () => {
    expect(isClosedFence("~~~hark:html\n<p>x</p>\n~~~")).toBe(true);
    expect(isClosedFence("~~~hark:html\n<p>x</p>\n```")).toBe(false);
  });
});

describe("isAllowedResourceUrl", () => {
  it.each([
    ["data:image/png;base64,iVBORw0KGgo=", true],
    ["DATA:image/svg+xml,<svg/>", true],
    ["/api/files?path=shot.png", true],
    ["./relative.png", true],
    ["relative.png", true],
    ["#fragment", true],
    ["https://evil.example/x?leak=1", false],
    ["HTTPS://evil.example/x", false],
    ["http://evil.example/x", false],
    ["//evil.example/x", false],
    ["ftp://evil.example/x", false],
    ["javascript:alert(1)", false],
    ["", false],
    ["   ", false],
  ])("%s → %s", (url, ok) => {
    expect(isAllowedResourceUrl(url)).toBe(ok);
  });
});

describe("scrubCssUrls", () => {
  it("keeps data: and same-origin url()s", () => {
    const css = 'background: url("data:image/png;base64,xx") url(/local.png);';
    expect(scrubCssUrls(css)).toBe(css);
  });

  it("neutralizes external url()s (quoted, unquoted, mixed case, spaced)", () => {
    expect(scrubCssUrls("background: url(https://evil.example/p.png);")).toBe(
      'background: url("data:,");',
    );
    expect(
      scrubCssUrls("background: URL( 'https://evil.example/p.png' );"),
    ).toBe('background: url("data:,");');
    expect(scrubCssUrls("background: url(//evil.example/p.png);")).toBe(
      'background: url("data:,");',
    );
  });

  it("drops @import wholesale", () => {
    expect(
      scrubCssUrls('@import url("https://evil.example/a.css"); p { color: red; }'),
    ).toBe(" p { color: red; }");
    expect(scrubCssUrls("@import 'x.css'")).toBe("");
  });

  it("leaves url()-free css untouched", () => {
    const css = ".card { color: var(--fg-1); padding: 8px; }";
    expect(scrubCssUrls(css)).toBe(css);
  });
});
