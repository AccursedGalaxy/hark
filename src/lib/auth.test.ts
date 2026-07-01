import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAuthCookie,
  constantTimeEquals,
  cookieDigestForToken,
  evaluateRequest,
  isAuthenticated,
  isLoopbackAddress,
  loadOrCreateToken,
  parseCookieHeader,
  type RequestFacts,
} from "./auth.js";

const TOKEN = "test-token-abc123";

describe("loadOrCreateToken", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hark-auth-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("generates a token on first boot and persists it", async () => {
    const dir = path.join(tmpDir, "hark");
    const first = await loadOrCreateToken(dir);
    expect(first.created).toBe(true);
    expect(first.filePath).toBe(path.join(dir, "token"));
    // 32 random bytes → 43 base64url chars; must be url/copy-paste safe.
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const second = await loadOrCreateToken(dir);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("writes the file 0600 in a 0700 dir", async () => {
    const dir = path.join(tmpDir, "hark");
    const { filePath } = await loadOrCreateToken(dir);
    const fileMode = (await fs.stat(filePath)).mode & 0o777;
    const dirMode = (await fs.stat(dir)).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("reads back a hand-written token, ignoring surrounding whitespace", async () => {
    await fs.writeFile(path.join(tmpDir, "token"), "  my-secret \n", "utf8");
    const { token, created } = await loadOrCreateToken(tmpDir);
    expect(created).toBe(false);
    expect(token).toBe("my-secret");
  });

  it("treats an empty file as missing and regenerates", async () => {
    await fs.writeFile(path.join(tmpDir, "token"), "\n", "utf8");
    const { token, created } = await loadOrCreateToken(tmpDir);
    expect(created).toBe(true);
    expect(token.length).toBeGreaterThan(0);
  });
});

describe("cookie digest", () => {
  it("is deterministic per token and differs across tokens", () => {
    expect(cookieDigestForToken(TOKEN)).toBe(cookieDigestForToken(TOKEN));
    expect(cookieDigestForToken(TOKEN)).not.toBe(cookieDigestForToken("other"));
    // hex(SHA-256) — 64 lowercase hex chars, safe as a raw cookie value.
    expect(cookieDigestForToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buildAuthCookie carries the digest with the right attributes", () => {
    const cookie = buildAuthCookie(TOKEN);
    expect(cookie).toContain(`hark_auth=${cookieDigestForToken(TOKEN)}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=31536000");
    // Served over plain HTTP on the tailnet — Secure would drop the cookie.
    expect(cookie).not.toContain("Secure");
  });
});

describe("constantTimeEquals", () => {
  it("accepts equal strings", () => {
    expect(constantTimeEquals(TOKEN, TOKEN)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(constantTimeEquals(TOKEN, "test-token-abc124")).toBe(false);
  });

  it("rejects mismatched lengths without throwing", () => {
    // Raw timingSafeEqual throws on length mismatch; hashing first must
    // make this a plain false instead of a 500.
    expect(constantTimeEquals(TOKEN, "short")).toBe(false);
    expect(constantTimeEquals("", TOKEN)).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("parseCookieHeader", () => {
  it("handles a missing header", () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
  });

  it("parses multiple cookies with whitespace", () => {
    const m = parseCookieHeader("a=1; hark_auth=deadbeef;  b = 2 ");
    expect(m.get("a")).toBe("1");
    expect(m.get("hark_auth")).toBe("deadbeef");
    expect(m.get("b")).toBe("2");
  });

  it("keeps values containing '=' intact and skips malformed parts", () => {
    const m = parseCookieHeader("a=b=c; noequals; =empty");
    expect(m.get("a")).toBe("b=c");
    expect(m.size).toBe(1);
  });

  it("first occurrence of a duplicated name wins", () => {
    expect(parseCookieHeader("x=first; x=second").get("x")).toBe("first");
  });
});

describe("isLoopbackAddress", () => {
  it("accepts IPv4, IPv6, and v4-mapped loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.0.0.53")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isLoopbackAddress("100.64.1.2")).toBe(false); // tailnet
    expect(isLoopbackAddress("192.168.1.10")).toBe(false); // LAN
    expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("1270.0.0.1")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});

// A remote (non-loopback) API GET with no credentials — the baseline that
// individual tests then vary.
function remoteFacts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    remoteAddress: "100.64.1.2",
    path: "/api/sessions",
    method: "GET",
    cookieHeader: undefined,
    authHeader: undefined,
    ...overrides,
  };
}

describe("isAuthenticated", () => {
  it("counts loopback as authenticated", () => {
    expect(
      isAuthenticated(remoteFacts({ remoteAddress: "127.0.0.1" }), TOKEN),
    ).toBe(true);
  });

  it("accepts a valid hark_auth cookie among others", () => {
    const facts = remoteFacts({
      cookieHeader: `theme=dark; hark_auth=${cookieDigestForToken(TOKEN)}`,
    });
    expect(isAuthenticated(facts, TOKEN)).toBe(true);
  });

  it("rejects a cookie carrying the raw token instead of the digest", () => {
    const facts = remoteFacts({ cookieHeader: `hark_auth=${TOKEN}` });
    expect(isAuthenticated(facts, TOKEN)).toBe(false);
  });

  it("rejects a cookie minted for a rotated-away token", () => {
    const facts = remoteFacts({
      cookieHeader: `hark_auth=${cookieDigestForToken("old-token")}`,
    });
    expect(isAuthenticated(facts, TOKEN)).toBe(false);
  });

  it("accepts a Bearer header with the token (case-insensitive scheme)", () => {
    expect(
      isAuthenticated(remoteFacts({ authHeader: `Bearer ${TOKEN}` }), TOKEN),
    ).toBe(true);
    expect(
      isAuthenticated(remoteFacts({ authHeader: `bearer ${TOKEN}` }), TOKEN),
    ).toBe(true);
  });

  it("rejects wrong or malformed Bearer headers", () => {
    expect(
      isAuthenticated(remoteFacts({ authHeader: "Bearer nope" }), TOKEN),
    ).toBe(false);
    expect(
      isAuthenticated(remoteFacts({ authHeader: "Bearer" }), TOKEN),
    ).toBe(false);
    expect(
      isAuthenticated(remoteFacts({ authHeader: TOKEN }), TOKEN),
    ).toBe(false);
  });
});

describe("evaluateRequest", () => {
  it("allows non-/api paths regardless of credentials (SPA shell)", () => {
    expect(evaluateRequest(remoteFacts({ path: "/" }), TOKEN)).toBe("allow");
    expect(
      evaluateRequest(remoteFacts({ path: "/assets/index-abc.js" }), TOKEN),
    ).toBe("allow");
    // Prefix must not overmatch: /apiary is not an API route.
    expect(evaluateRequest(remoteFacts({ path: "/apiary" }), TOKEN)).toBe(
      "allow",
    );
  });

  it("allows loopback peers on any /api route (local hooks, CLI curls)", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(
        evaluateRequest(
          remoteFacts({
            remoteAddress: addr,
            path: "/api/hook",
            method: "POST",
          }),
          TOKEN,
        ),
      ).toBe("allow");
    }
  });

  it("denies unauthenticated remote /api requests, including SSE routes", () => {
    expect(evaluateRequest(remoteFacts(), TOKEN)).toBe("deny");
    expect(evaluateRequest(remoteFacts({ path: "/api" }), TOKEN)).toBe("deny");
    expect(evaluateRequest(remoteFacts({ path: "/api/events" }), TOKEN)).toBe(
      "deny",
    );
    expect(
      evaluateRequest(
        remoteFacts({ path: "/api/sessions/abc/stream" }),
        TOKEN,
      ),
    ).toBe("deny");
    expect(
      evaluateRequest(
        remoteFacts({ path: "/api/sessions/abc/send", method: "POST" }),
        TOKEN,
      ),
    ).toBe("deny");
  });

  it("lets the auth endpoints through unauthenticated as 'login'", () => {
    expect(
      evaluateRequest(
        remoteFacts({ path: "/api/auth/login", method: "POST" }),
        TOKEN,
      ),
    ).toBe("login");
    expect(
      evaluateRequest(remoteFacts({ path: "/api/auth/status" }), TOKEN),
    ).toBe("login");
    // ...but only the exact method: no side door via other verbs.
    expect(
      evaluateRequest(remoteFacts({ path: "/api/auth/login" }), TOKEN),
    ).toBe("deny");
    expect(
      evaluateRequest(
        remoteFacts({ path: "/api/auth/status", method: "POST" }),
        TOKEN,
      ),
    ).toBe("deny");
  });

  it("allows a valid cookie or Bearer header on protected routes", () => {
    expect(
      evaluateRequest(
        remoteFacts({
          cookieHeader: `hark_auth=${cookieDigestForToken(TOKEN)}`,
        }),
        TOKEN,
      ),
    ).toBe("allow");
    expect(
      evaluateRequest(remoteFacts({ authHeader: `Bearer ${TOKEN}` }), TOKEN),
    ).toBe("allow");
  });
});
