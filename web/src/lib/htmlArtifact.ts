import { marked } from "marked";

// hark:html artifacts — a session opts into rich rendering by emitting a
// fenced code block tagged `hark:html`. The web UI renders the block's body
// as sanitized HTML inline in the transcript instead of as a code block.
// The tag is deliberately NOT bare `html`: agents routinely show HTML *code*
// to talk about it, and in the terminal TUI the artifact degrades to a plain
// code block, so rendering must be an explicit opt-in.
//
// This module is the IO-free half (fence splitting + URL policy), unit-tested
// in node. The DOMPurify wiring that consumes the policy lives in
// components/HtmlArtifact.tsx.

export const ARTIFACT_LANG = "hark:html";

export type ArtifactSegment =
  | { kind: "md"; text: string }
  | { kind: "artifact"; html: string; closed: boolean };

// Split markdown into ordinary-markdown runs and hark:html artifact blocks.
// Uses marked's lexer rather than a regex so that a `hark:html` fence shown
// *inside* another fence (e.g. a ````-quoted example) stays a code sample.
// Only top-level fences become artifacts — one nested in a list or quote
// renders as a normal code block, which is the safe default.
export function splitArtifacts(source: string): ArtifactSegment[] {
  // Fast path: the tag string not appearing anywhere means no artifacts.
  if (!source.toLowerCase().includes(ARTIFACT_LANG))
    return [{ kind: "md", text: source }];

  const segments: ArtifactSegment[] = [];
  let buf = "";
  for (const t of marked.lexer(source)) {
    if (
      t.type === "code" &&
      typeof t.lang === "string" &&
      t.lang.trim().split(/\s+/)[0]?.toLowerCase() === ARTIFACT_LANG
    ) {
      if (buf) {
        segments.push({ kind: "md", text: buf });
        buf = "";
      }
      segments.push({
        kind: "artifact",
        html: t.text,
        closed: isClosedFence(t.raw),
      });
    } else {
      buf += t.raw;
    }
  }
  if (buf) segments.push({ kind: "md", text: buf });
  return segments.length ? segments : [{ kind: "md", text: source }];
}

// GFM treats an unclosed fence as running to end-of-input, which is exactly
// what a still-streaming artifact looks like. Closed iff the block's last
// line is a valid closing fence for its opening marker (same char, at least
// as long, nothing else on the line).
export function isClosedFence(raw: string): boolean {
  const lines = raw.replace(/\s+$/, "").split("\n");
  if (lines.length < 2) return false;
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]);
  if (!open) return false;
  const marker = open[1];
  const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}$`);
  return close.test(lines[lines.length - 1].trimEnd());
}

// Resource-URL policy. Anything the browser fetches at RENDER time (img src,
// svg use/image href, CSS url(), …) is an exfiltration channel for a
// prompt-injected session — even on a private tailnet. Allowed: data: URIs
// and same-origin (relative) paths, which is all an artifact legitimately
// needs; the planned /api/files endpoint is same-origin too. <a href> is
// exempt at the call site: navigation requires a deliberate tap.
export function isAllowedResourceUrl(url: string): boolean {
  const u = url.trim();
  if (u === "") return false;
  if (u.startsWith("#")) return true;
  if (u.startsWith("//")) return false; // protocol-relative → external
  if (/^data:/i.test(u)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return false; // any other scheme
  return true; // relative / same-origin path
}

// Scrub CSS of external fetches: @import (fetches regardless of url() form)
// is dropped wholesale; url() targets failing the resource policy are
// replaced with an inert empty data URI (an empty url() can resolve to the
// document URL in some engines, so it isn't a safe placeholder).
export function scrubCssUrls(css: string): string {
  return css
    .replace(/@import[^;]*(;|$)/gi, "")
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, _q, target) =>
      isAllowedResourceUrl(target) ? match : 'url("data:,")',
    );
}
