import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Token-based auth boundary for the HTTP API. hark binds 0.0.0.0 and can
// drive live Claude Code sessions via tmux send-keys, so an open port is
// effectively remote code execution — every /api route must sit behind this.
//
// Scheme (stateless, survives restarts):
//   - One secret token at rest in ~/.config/hark/token (0600), generated on
//     first boot. `HARK_AUTH_TOKEN` overrides it for tests/dev.
//   - Browsers log in once (POST /api/auth/login) and get a `hark_auth`
//     cookie carrying hex(SHA-256("hark-cookie-v1:" + token)). The server
//     recomputes the digest per request, so no session store is needed and
//     rotating the token file invalidates every cookie at once.
//   - Scripts/curl send `Authorization: Bearer <token>` instead.
//   - Loopback peers are exempt: local Claude Code hooks POST /api/hook
//     with no credentials, and the CLI/dev tooling curls localhost.
//
// All comparisons go through sha256 + crypto.timingSafeEqual (never raw
// string equality) so attempts can't be timed against the secret.

export const COOKIE_NAME = "hark_auth";

// Versioned so a future scheme change can invalidate old cookies by bumping
// the prefix rather than forcing everyone to rotate their token.
const COOKIE_DIGEST_PREFIX = "hark-cookie-v1:";

// One year: the token is device-scoped ("log in once per phone/laptop"),
// not session-scoped. Revocation = delete the token file + restart.
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export function defaultTokenDir(): string {
  const root =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(root, "hark");
}

export interface LoadedToken {
  token: string;
  // Absolute path of the token file — logged at boot so the user knows
  // where to find it (the token itself is never logged).
  filePath: string;
  // True when this boot generated a fresh token (first run / deleted file).
  created: boolean;
}

// Read the token from `<dir>/token`, generating one on first boot. The file
// is 0600 in a 0700 dir: it's a bearer secret, other local users must not
// be able to read it. An empty/whitespace-only file is treated as missing
// (a truncated write would otherwise silently disable auth-by-login).
export async function loadOrCreateToken(
  dir = defaultTokenDir(),
): Promise<LoadedToken> {
  const filePath = path.join(dir, "token");
  try {
    const existing = (await fs.readFile(filePath, "utf8")).trim();
    if (existing) return { token: existing, filePath, created: false };
  } catch {
    /* missing or unreadable — fall through to generation */
  }
  // 32 random bytes → base64url keeps it copy-pasteable (no `+/=` that
  // would need escaping in curl or a password field).
  const token = crypto.randomBytes(32).toString("base64url");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, token + "\n", { encoding: "utf8", mode: 0o600 });
  return { token, filePath, created: true };
}

// The value the `hark_auth` cookie carries. A digest — not the token — so a
// leaked cookie jar never exposes the secret itself, and so verification is
// a pure recomputation (no server-side session state).
export function cookieDigestForToken(token: string): string {
  return crypto
    .createHash("sha256")
    .update(COOKIE_DIGEST_PREFIX + token)
    .digest("hex");
}

// Full Set-Cookie value for a successful login. No `Secure` flag: hark is
// served over plain HTTP on the tailnet, where Secure would silently drop
// the cookie. SameSite=Lax + HttpOnly keep it away from cross-site requests
// and page script.
export function buildAuthCookie(token: string): string {
  return (
    `${COOKIE_NAME}=${cookieDigestForToken(token)}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
  );
}

// Constant-time string comparison. Both sides are hashed first so inputs of
// different lengths are still compared over equal-length buffers —
// crypto.timingSafeEqual throws on length mismatch, and short-circuiting on
// length would itself leak the secret's length.
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Minimal Cookie-header parser (name=value pairs, `;`-separated). We only
// ever look up our own cookie, so no decoding/quoting cleverness — the
// digest value is plain hex. First occurrence of a name wins.
export function parseCookieHeader(
  header: string | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

// Loopback peers bypass auth. IMPORTANT: this checks the actual socket peer
// address, never X-Forwarded-For or similar spoofable headers. Node reports
// IPv4 loopback as `127.x.x.x`, IPv6 as `::1`, and (on dual-stack sockets,
// which `app.listen` without a host uses) v4-mapped as `::ffff:127.x.x.x`.
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.")
  );
}

// Everything the auth decision needs, extracted from the request so the
// decision itself is a pure, unit-testable function (server.ts just wires
// Express's req into this shape).
export interface RequestFacts {
  remoteAddress: string | undefined;
  path: string;
  method: string;
  cookieHeader: string | undefined;
  authHeader: string | undefined;
}

// "Is this peer authenticated?" — shared by the middleware and the
// /api/auth/status probe. Loopback counts as authenticated: those callers
// were never asked to log in, and status exists so the client can decide
// whether to show the login card.
export function isAuthenticated(
  facts: Pick<RequestFacts, "remoteAddress" | "cookieHeader" | "authHeader">,
  token: string,
): boolean {
  if (isLoopbackAddress(facts.remoteAddress)) return true;
  const cookie = parseCookieHeader(facts.cookieHeader).get(COOKIE_NAME);
  if (cookie && constantTimeEquals(cookie, cookieDigestForToken(token))) {
    return true;
  }
  const auth = facts.authHeader;
  if (auth && /^bearer\s+/i.test(auth)) {
    const bearer = auth.replace(/^bearer\s+/i, "").trim();
    if (bearer && constantTimeEquals(bearer, token)) return true;
  }
  return false;
}

export type AuthVerdict = "allow" | "login" | "deny";

// The per-request decision, in precedence order:
//   allow  — non-/api paths (the SPA shell + assets must load so the login
//            screen can render; all data lives behind /api), loopback peers,
//            and authenticated requests (cookie or Bearer header).
//   login  — the two unauthenticated-but-reachable auth endpoints
//            (POST /api/auth/login, GET /api/auth/status). The middleware
//            passes these through; their handlers do their own checks.
//   deny   — everything else under /api → 401.
export function evaluateRequest(
  facts: RequestFacts,
  token: string,
): AuthVerdict {
  if (facts.path !== "/api" && !facts.path.startsWith("/api/")) return "allow";
  if (isAuthenticated(facts, token)) return "allow";
  if (facts.method === "POST" && facts.path === "/api/auth/login") {
    return "login";
  }
  if (facts.method === "GET" && facts.path === "/api/auth/status") {
    return "login";
  }
  return "deny";
}
