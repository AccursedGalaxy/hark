import { useMemo, useState } from "react";
import type { SessionView } from "../hooks/useSessions";
import type { TranscriptEvent } from "../lib/protocol";
import { shortId, tildeify } from "../lib/format";
import {
  aggregateUsage,
  contextLimitForModel,
  humanCost,
  humanDuration,
  humanTokens,
  shortModel,
} from "../lib/usage";
import { ChevIcon, EditIcon, FileIcon } from "./icons";

// Right rail — live session telemetry derived from the JSONL transcript:
// context-window meter, cost, token mix, tool histogram, recent files,
// errors, and the original session metadata block (kept, collapsed).
export function ContextRail({
  session,
  events,
}: {
  session: SessionView;
  events: TranscriptEvent[];
}) {
  const stats = useMemo(() => deriveStats(events), [events]);
  const usage = useMemo(() => aggregateUsage(events), [events]);

  // Session id stays the most user-irrelevant block, so it collapses by
  // default. Persistence across sessions is overkill — local state is fine.
  const [showMeta, setShowMeta] = useState(false);

  const contextLimit = contextLimitForModel(usage.model);
  const ctxPct = Math.min(
    100,
    Math.round((usage.currentContextTokens / contextLimit) * 100),
  );
  const ctxTone =
    ctxPct >= 90 ? "coral" : ctxPct >= 70 ? "amber" : "jade";

  const sessionDurationMs =
    session.startedAt ? Date.now() - session.startedAt : 0;
  const lastTurnAgoMs = usage.lastAssistantAt
    ? Date.now() - usage.lastAssistantAt
    : session.lastEventAt
      ? Date.now() - session.lastEventAt
      : undefined;

  const hasErrors = usage.apiErrors > 0 || usage.retries > 0 || stats.hookErrors > 0;
  const cacheHitPct = Math.round(usage.cacheHitRatio * 100);

  return (
    <aside className="context-rail" data-screen-label="ContextRail">
      {/* ── Hero: context window meter ─────────────────────────────── */}
      <div className="ctx-section ctx-hero">
        <h4>
          Context window
          <span className={`ctx-model-badge tone-${ctxTone}`}>
            {shortModel(usage.model)}
          </span>
        </h4>
        <div className="ctx-meter-row">
          <span className="ctx-meter-num">
            {humanTokens(usage.currentContextTokens)}
          </span>
          <span className="ctx-meter-of">
            of {humanTokens(contextLimit)}
          </span>
          <span className={`ctx-meter-pct tone-${ctxTone}`}>{ctxPct}%</span>
        </div>
        <div className={`ctx-meter tone-${ctxTone}`}>
          <i style={{ width: `${ctxPct}%` }} />
        </div>
        {usage.lastStopReason === "max_tokens" && (
          <div className="ctx-flag tone-coral">
            last turn hit max_output_tokens
          </div>
        )}
      </div>

      {/* ── Cost + efficiency tiles ───────────────────────────────── */}
      <div className="ctx-section">
        <h4>Session economics</h4>
        <div className="ctx-tiles">
          <Tile label="cost" value={humanCost(usage.costUsd)} accent />
          <Tile
            label="cache hit"
            value={`${cacheHitPct}%`}
            tone={cacheHitPct >= 80 ? "jade" : cacheHitPct >= 50 ? "amber" : "coral"}
          />
          <Tile label="output" value={humanTokens(usage.outputTokens)} />
          <Tile label="input" value={humanTokens(usage.inputTokens)} />
        </div>
        <div className="ctx-bands" title="cache_read vs cache_create vs raw input">
          <CacheBand
            read={usage.cacheReadTokens}
            create={usage.cacheCreationTokens}
            input={usage.inputTokens}
          />
        </div>
        <div className="ctx-band-legend">
          <span title={`cache reads — ${usage.cacheReadTokens.toLocaleString()} tokens`}>
            <i className="dot tone-jade" />
            <span className="lbl">cached</span>
            <span className="val">{humanTokens(usage.cacheReadTokens)}</span>
          </span>
          <span title={`cache writes — ${usage.cacheCreationTokens.toLocaleString()} tokens`}>
            <i className="dot tone-amber" />
            <span className="lbl">written</span>
            <span className="val">{humanTokens(usage.cacheCreationTokens)}</span>
          </span>
          <span title={`uncached input — ${usage.inputTokens.toLocaleString()} tokens`}>
            <i className="dot tone-indigo" />
            <span className="lbl">fresh</span>
            <span className="val">{humanTokens(usage.inputTokens)}</span>
          </span>
        </div>
      </div>

      {/* ── Activity ──────────────────────────────────────────────── */}
      <div className="ctx-section">
        <h4>Activity</h4>
        <div className="ctx-tiles">
          <Tile label="turns" value={String(stats.turns)} />
          <Tile label="tools" value={String(stats.toolUses)} />
          <Tile
            label="duration"
            value={humanDuration(sessionDurationMs)}
          />
          <Tile
            label="last turn"
            value={
              lastTurnAgoMs === undefined
                ? "—"
                : `${humanDuration(lastTurnAgoMs)} ago`
            }
          />
        </div>
        {(usage.webSearches > 0 || usage.webFetches > 0) && (
          <div className="ctx-subline">
            web: {usage.webSearches} searches · {usage.webFetches} fetches
          </div>
        )}
      </div>

      {/* ── Tool histogram ────────────────────────────────────────── */}
      {stats.toolHistogram.length > 0 && (
        <div className="ctx-section">
          <h4>Tools</h4>
          <ol className="ctx-hist">
            {stats.toolHistogram.map((t) => (
              <li key={t.name}>
                <span className="ctx-hist-name" title={t.name}>
                  {prettyToolName(t.name)}
                </span>
                <span className="ctx-hist-bar">
                  <i style={{ width: `${(t.count / stats.toolHistogram[0].count) * 100}%` }} />
                </span>
                <span className="ctx-hist-n">{t.count}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* ── Recent files ──────────────────────────────────────────── */}
      {stats.recentFiles.length > 0 && (
        <div className="ctx-section">
          <h4>
            Files touched
            <span className="ctx-h4-count">{stats.uniqueFiles}</span>
          </h4>
          {stats.recentFiles.map((f) => (
            <div className="ctx-file" key={f.path}>
              {f.action === "write" || f.action === "edit" ? (
                <EditIcon />
              ) : (
                <FileIcon />
              )}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={f.path}
              >
                {basename(f.path)}
              </span>
              <span className={`ctx-file-dl tone-${actionTone(f.action)}`}>
                {f.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Errors / retries (conditional) ───────────────────────── */}
      {hasErrors && (
        <div className="ctx-section ctx-errors">
          <h4>Issues</h4>
          <div className="ctx-tiles">
            {usage.apiErrors > 0 && (
              <Tile
                label="api errors"
                value={String(usage.apiErrors)}
                tone="coral"
              />
            )}
            {usage.retries > 0 && (
              <Tile
                label="retries"
                value={String(usage.retries)}
                tone="amber"
              />
            )}
            {stats.hookErrors > 0 && (
              <Tile
                label="hook fails"
                value={String(stats.hookErrors)}
                tone="coral"
              />
            )}
          </div>
        </div>
      )}

      {/* ── Live status ──────────────────────────────────────────── */}
      <div className="ctx-section">
        <h4>Status</h4>
        <dl className="kv">
          <dt>state</dt>
          <dd
            style={{
              color: stateColor(session.state),
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              fontFamily: "var(--mono)",
              fontSize: 11.5,
            }}
          >
            {session.state}
          </dd>
          <dt>tmux pane</dt>
          <dd
            style={{
              color: session.hasTmuxPane ? "var(--jade)" : "var(--coral)",
            }}
          >
            {session.hasTmuxPane ? "attached" : "read-only"}
          </dd>
          {session.waitingFor && (
            <>
              <dt>waiting on</dt>
              <dd style={{ color: "var(--amber)" }}>{session.waitingFor}</dd>
            </>
          )}
        </dl>
      </div>

      {/* ── Session metadata (collapsed by default) ──────────────── */}
      <div className="ctx-section ctx-meta">
        <button
          type="button"
          className="ctx-meta-toggle"
          onClick={() => setShowMeta((v) => !v)}
          aria-expanded={showMeta}
        >
          <span className={`ctx-meta-chev ${showMeta ? "open" : ""}`}>
            <ChevIcon />
          </span>
          Session details
          <span className="ctx-meta-id">#{shortId(session.sessionId)}</span>
        </button>
        {showMeta && (
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>started</dt>
            <dd>{relTime(session.startedAt)}</dd>
            <dt>kind</dt>
            <dd>{session.kind}</dd>
            {session.version && (
              <>
                <dt>version</dt>
                <dd style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                  v{session.version}
                </dd>
              </>
            )}
            <dt>cwd</dt>
            <dd
              style={{
                fontFamily: "var(--mono)",
                fontSize: 11.5,
                wordBreak: "break-all",
              }}
              title={session.cwd}
            >
              {tildeify(session.cwd)}
            </dd>
            {session.tmuxLocation && (
              <>
                <dt>tmux</dt>
                <dd
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--indigo)",
                  }}
                >
                  {session.tmuxLocation}
                </dd>
              </>
            )}
            <dt>pid</dt>
            <dd style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              {session.pid}
            </dd>
          </dl>
        )}
      </div>
    </aside>
  );
}

// ── Tile ───────────────────────────────────────────────────────────
//
// Compact "label + value" stat block. `accent` swaps the value to the
// serif italic treatment so a single hero tile (cost) can stand out from
// the rest without breaking the grid.
function Tile({
  label,
  value,
  tone,
  accent,
}: {
  label: string;
  value: string;
  tone?: "jade" | "amber" | "coral" | "indigo";
  accent?: boolean;
}) {
  return (
    <div className={`ctx-tile${tone ? ` tone-${tone}` : ""}`}>
      <div className={`ctx-tile-val ${accent ? "accent" : ""}`}>{value}</div>
      <div className="ctx-tile-lbl">{label}</div>
    </div>
  );
}

// ── CacheBand ─────────────────────────────────────────────────────
//
// 100%-stacked horizontal bar showing the split between cached reads,
// cache writes, and uncached fresh input. The three slices sum to 100%.
function CacheBand({
  read,
  create,
  input,
}: {
  read: number;
  create: number;
  input: number;
}) {
  const total = Math.max(1, read + create + input);
  const pct = (n: number) => (n / total) * 100;
  return (
    <div className="ctx-band" role="img" aria-label="token mix">
      <i className="seg tone-jade" style={{ width: `${pct(read)}%` }} />
      <i className="seg tone-amber" style={{ width: `${pct(create)}%` }} />
      <i className="seg tone-indigo" style={{ width: `${pct(input)}%` }} />
    </div>
  );
}

// ── Derivations ───────────────────────────────────────────────────

interface DerivedStats {
  turns: number;
  toolUses: number;
  recentFiles: { path: string; action: string; detail: string }[];
  uniqueFiles: number;
  toolHistogram: { name: string; count: number }[];
  hookErrors: number;
}

function deriveStats(events: TranscriptEvent[]): DerivedStats {
  let turns = 0;
  let toolUses = 0;
  let hookErrors = 0;
  const fileMap = new Map<string, { action: string; detail: string; ts: number }>();
  const toolCounts = new Map<string, number>();

  for (const ev of events) {
    if (ev.kind === "user") turns++;
    if (ev.kind === "system" && /hook.*(fail|error)/i.test(ev.text)) {
      hookErrors++;
    }
    if (ev.kind !== "assistant") continue;
    for (const b of ev.blocks) {
      if (b.type !== "tool_use") continue;
      toolUses++;
      toolCounts.set(b.name, (toolCounts.get(b.name) ?? 0) + 1);
      const input = (b.input ?? {}) as Record<string, unknown>;
      const filePath =
        typeof input.file_path === "string" ? input.file_path : undefined;
      if (!filePath) continue;
      const ts = Date.parse(ev.ts) || 0;
      let action = "read";
      let detail = "";
      if (b.name === "Edit") {
        action = "edit";
        detail = "edited";
      } else if (b.name === "Write") {
        action = "write";
        detail = "written";
      } else if (b.name === "Read") {
        action = "read";
        detail = "read";
      } else {
        continue;
      }
      const cur = fileMap.get(filePath);
      if (!cur || ts > cur.ts) {
        fileMap.set(filePath, { action, detail, ts });
      }
    }
  }

  const recentFiles = [...fileMap.entries()]
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, 6)
    .map(([path, info]) => ({ path, action: info.action, detail: info.detail }));

  const toolHistogram = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    turns,
    toolUses,
    recentFiles,
    uniqueFiles: fileMap.size,
    toolHistogram,
    hookErrors,
  };
}

// Strip the long MCP/plugin prefixes so the histogram doesn't break the
// rail's narrow column. Falls through unchanged for short names.
function prettyToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return parts[parts.length - 1] || name;
  }
  return name;
}

function basename(p: string): string {
  if (!p) return p;
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function relTime(ms: number | undefined): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "just now";
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  return `${day}d ago`;
}

function stateColor(s: string): string {
  switch (s) {
    case "busy":
      return "var(--accent)";
    case "wait":
      return "var(--amber)";
    case "idle":
      return "var(--jade)";
    default:
      return "var(--coral)";
  }
}

function actionTone(action: string): string {
  switch (action) {
    case "write":
      return "amber";
    case "edit":
      return "indigo";
    default:
      return "fg-3";
  }
}
