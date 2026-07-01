import { appendFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PromptState, type HookEventInput } from "./promptState.js";
import { SessionIndex } from "./sessionIndex.js";
import { parseTranscript, type TranscriptEvent } from "./transcript.js";
import { TranscriptCache } from "./transcriptCache.js";
import { openTranscriptStream } from "./transcriptStream.js";
import type { SseWriter, TranscriptStreamHandle } from "./transcriptStream.js";

// ---------------------------------------------------------------------------
// Memory-regression guard.
//
// The server used to heap-OOM every 5-8 hours ("Ineffective mark-compacts
// near heap limit") because a long-lived hot path retained a little memory on
// every request. This suite is the CI tripwire against that class of bug
// coming back: it hammers each long-lived hot path in a loop and asserts that
// heap growth stays bounded — a per-iteration retention of even a few KB
// multiplies past the thresholds below.
//
// Methodology (per hot path):
//   1. Warm up (JIT, lazily-allocated caches, module-level state reach
//      steady state).
//   2. Force GC and snapshot heapUsed.
//   3. Run the measured iterations — the "second half".
//   4. Force GC and snapshot again; assert (after - before) < threshold.
//
// Asserting on second-half growth (not absolute totals) makes the numbers
// robust: steady-state allocations from the warmup phase are already counted
// in the "before" snapshot, so only *per-iteration* retention shows up.
//
// GC access: these tests only mean something when V8's GC can be forced, so
// they run under `--expose-gc` (CI: the "memory regression guard" step;
// locally: `npm run test:memory`). Without the flag they SKIP — visibly, via
// it.skipIf — rather than silently passing with meaningless numbers.
//
// Threshold calibration (measured on Node 25, linux x64, 2026-07; see the
// per-test comments for the observed numbers): observed post-GC growth was
// single-digit-to-low-double-digit KiB per path across repeated runs. Each
// threshold is set with a wide margin above that noise (to absorb CI
// allocator/V8-version variance) but at least ~4x below the smallest
// plausible real-leak signal for that path, so a genuine per-iteration
// retention still trips it unambiguously.
// ---------------------------------------------------------------------------

type GcFn = () => void;
// `globalThis.gc` only exists under --expose-gc. Narrow it once; every test
// below skips (not fakes) when it's absent.
const gc: GcFn | undefined = (globalThis as { gc?: GcFn }).gc;

/**
 * Force a full GC and return heapUsed. Runs several gc() passes with a
 * macrotask in between: a single pass doesn't run pending finalizers /
 * WeakRef callbacks, and objects freed by those only become collectable on
 * the following pass.
 */
async function settledHeapUsed(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    gc!();
    await new Promise((r) => setImmediate(r));
  }
  return process.memoryUsage().heapUsed;
}

/**
 * Run `warmup`, snapshot, run `measured`, snapshot again. Logs the observed
 * growth (so CI output always shows the real numbers next to the threshold)
 * and returns it in bytes.
 */
async function measureGrowth(
  name: string,
  warmup: () => Promise<void>,
  measured: () => Promise<void>,
): Promise<number> {
  await warmup();
  const before = await settledHeapUsed();
  await measured();
  const after = await settledHeapUsed();
  const growth = after - before;
  // eslint-disable-next-line no-console
  console.log(
    `[memory] ${name}: ${(growth / 1024).toFixed(0)} KiB growth ` +
      `(${(before / 1048576).toFixed(1)} MiB -> ${(after / 1048576).toFixed(1)} MiB)`,
  );
  return growth;
}

const KiB = 1024;
const MiB = 1024 * KiB;

// --- Synthetic transcript ---------------------------------------------------
// Realistic-shaped JSONL rows matching what Claude Code writes (same shapes
// as the fixtures in transcript.test.ts / transcriptStream.test.ts): a user
// prompt, an assistant turn with thinking + text + tool_use + usage, and the
// tool_result user row with its toolUseResult sidecar.

function isoTs(i: number): string {
  return new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + i * 1000).toISOString();
}

function turnLines(i: number, outputBytes: number): string {
  const pad = "x".repeat(outputBytes);
  const toolUseId = `toolu_${i.toString().padStart(8, "0")}`;
  const user = JSON.stringify({
    type: "user",
    uuid: `u${i}`,
    timestamp: isoTs(i),
    message: { role: "user", content: `prompt ${i}: please run step ${i}` },
  });
  const assistant = JSON.stringify({
    type: "assistant",
    uuid: `a${i}`,
    timestamp: isoTs(i),
    message: {
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 1200 + i,
        output_tokens: 80,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 900,
      },
      content: [
        { type: "thinking", thinking: `considering step ${i}` },
        { type: "text", text: `running step ${i}` },
        { type: "tool_use", id: toolUseId, name: "Bash", input: { command: `echo ${i}` } },
      ],
    },
  });
  const toolResult = JSON.stringify({
    type: "user",
    uuid: `r${i}`,
    timestamp: isoTs(i),
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: pad, is_error: false },
      ],
    },
    toolUseResult: { stdout: pad, stderr: "", interrupted: false, isImage: false },
  });
  return `${user}\n${assistant}\n${toolResult}\n`;
}

/** Build a JSONL blob of `turns` three-row turns (~(2*outputBytes + 1.2KB) per turn). */
function makeTranscriptBlob(turns: number, outputBytes: number): string {
  const parts: string[] = [];
  for (let i = 0; i < turns; i++) parts.push(turnLines(i, outputBytes));
  return parts.join("");
}

describe("memory regression guard", () => {
  let dir: string;
  // ~4.7 MB — big enough that retaining even one parse result per iteration
  // is a multi-MB signal, and comparable to the real multi-MB session
  // transcripts the production server chews on.
  let bigBlob: string;
  let bigFile: string;
  // ~180 KB — used where each iteration parses a whole file (TranscriptCache
  // churn) so the loop stays fast while per-entry retention stays visible.
  let smallBlob: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "hark-memguard-"));
    bigBlob = makeTranscriptBlob(1500, 1024);
    smallBlob = makeTranscriptBlob(60, 1024);
    bigFile = path.join(dir, "big-session.jsonl");
    await writeFile(bigFile, bigBlob);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ---- transcript.ts: full-file JSONL parse --------------------------------
  // The parse that backs every transcript GET. Each iteration parses the
  // full multi-MB blob and drops the result; nothing may accumulate across
  // parses (parseTranscript builds a fresh ToolNameIndex per call).
  it.skipIf(!gc)(
    "parseTranscript: repeated multi-MB parses do not retain memory",
    { timeout: 60_000 },
    async () => {
      let sink = 0; // defeat dead-code elimination of the parse result
      const parseOnce = () => {
        const events = parseTranscript(bigBlob);
        sink += events.length;
      };
      const growth = await measureGrowth(
        "parseTranscript x15 (4.7MB blob)",
        async () => {
          for (let i = 0; i < 5; i++) parseOnce();
        },
        async () => {
          for (let i = 0; i < 15; i++) parseOnce();
        },
      );
      expect(sink).toBeGreaterThan(0);
      // Calibrated 2026-07: observed 8–19 KiB across runs. Smallest plausible
      // real leak — retaining just the per-parse ToolNameIndex (1500 entries)
      // per iteration — is ~2+ MiB over 15 iterations; retaining the events
      // themselves is ~150 MiB. 1 MiB sits far above noise, below both.
      expect(growth).toBeLessThan(1 * MiB);
    },
  );

  // ---- transcriptCache.ts: LRU churn ---------------------------------------
  // The server-side parse cache is capped at maxEntries; feeding it a stream
  // of never-repeating paths forces constant eviction. If eviction ever
  // breaks (the original OOM was exactly this shape: an unbounded map of
  // parsed transcripts), every one of the 300 measured reads retains a full
  // parsed transcript and growth explodes.
  it.skipIf(!gc)(
    "TranscriptCache: LRU eviction keeps churn bounded",
    { timeout: 60_000 },
    async () => {
      const buf = Buffer.from(smallBlob, "utf8");
      // Injected deps: no real files needed, so the loop measures exactly
      // the cache's own retention, not fs behaviour.
      const cache = new TranscriptCache(5, {
        stat: async (p) => ({ size: buf.length, mtimeMs: p.length }),
        readFile: async () => buf,
      });
      let n = 0;
      const readOne = async () => {
        await cache.read(`/virtual/${n++}.jsonl`); // unique path -> miss + evict
      };
      const growth = await measureGrowth(
        "TranscriptCache x300 unique paths (180KB each)",
        async () => {
          for (let i = 0; i < 100; i++) await readOne();
        },
        async () => {
          for (let i = 0; i < 300; i++) await readOne();
        },
      );
      // Calibrated 2026-07: observed -3 to 0 KiB (allocator jitter around
      // zero). A broken LRU retains ~300 parsed transcripts ≈ 100+ MiB;
      // even one stuck entry is ~400 KiB. 1 MiB is far above noise and any
      // real eviction bug lands orders of magnitude beyond it.
      expect(growth).toBeLessThan(1 * MiB);
    },
  );

  // ---- transcriptStream.ts: SSE stream open/close churn ---------------------
  // Every session view opens one of these; phones reconnecting on flaky
  // links open and close them constantly. Each open does the expensive
  // priming read (full file -> ToolNameIndex) and registers an fs.watch;
  // close() must release both. A close() that leaks its watcher keeps the
  // drain closure — and the per-stream ToolNameIndex behind it — alive.
  it.skipIf(!gc)(
    "openTranscriptStream: open/close cycles release watchers and indexes",
    { timeout: 120_000 },
    async () => {
      const nullWriter: SseWriter = { comment: () => {}, event: () => {} };
      const cycle = async () => {
        const handle = await openTranscriptStream(bigFile, nullWriter, {
          heartbeatMs: 0, // no timer — this test targets watcher/index leaks
        });
        handle.close();
      };
      const growth = await measureGrowth(
        "openTranscriptStream x40 open/close (4.7MB file)",
        async () => {
          for (let i = 0; i < 10; i++) await cycle();
        },
        async () => {
          for (let i = 0; i < 40; i++) await cycle();
        },
      );
      // Calibrated 2026-07: observed 4 KiB, dead stable across runs. A
      // leaked stream retains its ToolNameIndex (1500 entries) + drain
      // closures — ~150+ KiB per cycle, ~6+ MiB over 40 cycles. 1 MiB is
      // ~250x the observed noise and ~6x under the leak signal.
      expect(growth).toBeLessThan(1 * MiB);

      // Behavioural cleanup check: after close(), the fs.watch must be gone.
      // The module keeps no watcher registry to inspect (and active-handle
      // introspection is flaky), so assert the observable contract instead:
      // an append after close must produce zero events on any writer.
      const writers = Array.from({ length: 5 }, () => {
        const events: unknown[] = [];
        const w: SseWriter & { events: unknown[] } = {
          events,
          comment: () => {},
          event: (name) => events.push(name),
        };
        return w;
      });
      const handles: TranscriptStreamHandle[] = [];
      for (const w of writers) {
        handles.push(await openTranscriptStream(bigFile, w, { heartbeatMs: 0 }));
      }
      for (const h of handles) h.close();
      await appendFile(bigFile, turnLines(999_999, 32));
      // fs.watch delivery is async; give a leaked watcher time to fire.
      await new Promise((r) => setTimeout(r, 150));
      for (const w of writers) {
        // Exactly the one "ready" from open — nothing after close.
        expect(w.events).toEqual(["ready"]);
      }
    },
  );

  // ---- promptState.ts: hook-event ingest ------------------------------------
  // One PromptState lives for the whole server process and every hook POST
  // flows through record(); transcript batches flow through
  // noteTranscriptEvents(). State is keyed by session id, so with a recycled
  // pool of ids (matching reality: a bounded set of live sessions) the maps
  // must reach a fixed point — per-event retention is the leak shape.
  it.skipIf(!gc)(
    "PromptState: sustained hook ingest reaches a fixed point",
    { timeout: 60_000 },
    async () => {
      const state = new PromptState();
      const sessionIds = Array.from({ length: 25 }, (_, i) => `sess-${i}`);
      // A realistic transcript batch replayed on every iteration: the events
      // are treated as read-only by PromptState, so sharing one array is safe
      // and keeps the loop cost on the ingest path, not on fixture building.
      const batch: TranscriptEvent[] = parseTranscript(smallBlob).slice(0, 12);
      let n = 0;
      const ingestOne = () => {
        const sid = sessionIds[n % sessionIds.length];
        // Full permission lifecycle: request (allocates pending + meta) then
        // resolution via Stop (must free both) — the pairing that leaks if
        // either map forgets to delete.
        const req: HookEventInput = {
          session_id: sid,
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: `echo ${n}` },
          tool_use_id: `toolu_${n}`,
          transcript_path: `/virtual/${sid}.jsonl`,
          message: `Claude wants to run a command (${n})`,
        };
        state.record(req);
        state.noteTranscriptEvents(sid, batch);
        state.record({ session_id: sid, hook_event_name: "Stop" });
        n++;
      };
      const growth = await measureGrowth(
        "PromptState x10k permission lifecycles (25 sessions)",
        async () => {
          for (let i = 0; i < 5_000; i++) ingestOne();
        },
        async () => {
          for (let i = 0; i < 10_000; i++) ingestOne();
        },
      );
      // Calibrated 2026-07: observed 1 KiB. Retaining even ~50 bytes per
      // lifecycle (a forgotten map entry) is ~500 KiB over 10k iterations;
      // a full pending snapshot per lifecycle is ~10 MiB. 512 KiB keeps the
      // guard sensitive to the small-object shape while far above noise.
      expect(growth).toBeLessThan(512 * KiB);
    },
  );

  // ---- sessionIndex.ts / sessionList.ts: watcher-backed session index -------
  // One SessionIndex lives for the whole process; every /api/sessions read
  // and SSE push flows through it. Its caches are keyed by sessionId / pid /
  // path, so with a fixed session population repeated scans must not grow.
  // All external probes (liveness, tmux, title reads) are injected so the
  // loop measures the index's own retention.
  it.skipIf(!gc)(
    "SessionIndex: repeated scans over a fixed session set stay bounded",
    { timeout: 60_000 },
    async () => {
      const sessionsDir = path.join(dir, "sessions");
      const projectsDir = path.join(dir, "projects");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(path.join(projectsDir, "proj-a"), { recursive: true });
      const sessionIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const sessionId = `mem-sess-${i}`;
        sessionIds.push(sessionId);
        await writeFile(
          path.join(sessionsDir, `s${i}.json`),
          JSON.stringify({
            pid: 10_000 + i,
            sessionId,
            cwd: "/home/user/proj",
            startedAt: 1_750_000_000_000,
            updatedAt: 1_750_000_000_000 + i,
            version: "2.1.0",
            kind: "interactive",
            status: "idle",
          }),
        );
        // Half the sessions have a transcript (found paths cache forever),
        // half don't (misses re-probe every call with negativeTtlMs: 0 —
        // deliberately the worst case for the probe path).
        if (i % 2 === 0) {
          await writeFile(
            path.join(projectsDir, "proj-a", `${sessionId}.jsonl`),
            turnLines(i, 32),
          );
        }
      }
      const index = new SessionIndex({
        sessionsDir,
        projectsDir,
        negativeTtlMs: 0, // force the transcript probe on every miss
        paneTtlMs: 0, //     force a fresh pane resolve on every call
        locationsTtlMs: 0, // force a fresh locations fetch on every call
        isAlive: () => true,
        // Fresh objects per call: if the index ever accumulates results
        // instead of replacing them, the growth is unmissable.
        resolvePane: async (pid) => ({
          paneId: `%${pid}`,
          socket: `/tmp/tmux-1000/default-${pid}`,
        }),
        listLocations: async () => new Map(),
        readTitle: async (p) => `title of ${p}`,
      });
      const iterate = async () => {
        await index.rescan(); // re-read + re-parse all session files
        const sessions = await index.listSessions(); // liveness + dedupe + sort
        for (const s of sessions) {
          const tp = await index.transcriptPathFor(s.sessionId);
          if (tp) await index.titleFor(tp);
          await index.paneFor(s.pid);
        }
        await index.paneLocations();
        // Subscribe/unsubscribe churn: SSE clients do this on every
        // (re)connect; the subscriber Set must not retain dead callbacks.
        const unsubscribe = index.onChange(() => {});
        unsubscribe();
      };
      const growth = await measureGrowth(
        "SessionIndex x300 scan cycles (10 sessions)",
        async () => {
          for (let i = 0; i < 50; i++) await iterate();
        },
        async () => {
          for (let i = 0; i < 300; i++) await iterate();
        },
      );
      index.close();
      // Calibrated 2026-07: observed a stable ~92–95 KiB regardless of
      // iteration count (200 vs 400 measured cycles both land there), i.e.
      // a one-time lazy-allocation offset, not per-cycle retention.
      // Retaining even one parsed scan result (~2 KiB) per cycle is ~600
      // KiB over 300 cycles. 512 KiB clears the offset ~5x while still
      // tripping on that smallest-object leak shape.
      expect(growth).toBeLessThan(512 * KiB);
    },
  );
});
