import { useMemo } from "react";
import type { SessionView } from "../hooks/useSessions";
import type { TranscriptEvent } from "../lib/protocol";
import { shortId, tildeify } from "../lib/format";
import { EditIcon, FileIcon } from "./icons";

// Right rail — session metadata, turn/context counters, recently-touched files,
// derived from the live transcript.
export function ContextRail({
  session,
  events,
}: {
  session: SessionView;
  events: TranscriptEvent[];
}) {
  const stats = useMemo(() => deriveStats(events), [events]);

  return (
    <aside className="context-rail" data-screen-label="ContextRail">
      <div className="ctx-section">
        <h4>Session</h4>
        <dl className="kv">
          <dt>id</dt>
          <dd
            style={{
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--fg-0)",
            }}
          >
            #{shortId(session.sessionId)}
          </dd>
          <dt>started</dt>
          <dd>{relTime(session.startedAt)}</dd>
          <dt>kind</dt>
          <dd>{session.kind}</dd>
          {session.version && (
            <>
              <dt>version</dt>
              <dd
                style={{ fontFamily: "var(--mono)", fontSize: 12 }}
              >
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
      </div>

      <div className="ctx-section">
        <h4>Activity</h4>
        <div className="metric">
          <span className="num">
            {stats.turns}
            <span style={{ fontSize: 18, color: "var(--fg-3)" }}>
              {" "}turns
            </span>
          </span>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "4px 12px",
            marginTop: 12,
            fontFamily: "var(--mono)",
            fontSize: 11.5,
          }}
        >
          <span style={{ color: "var(--fg-3)" }}>tools</span>
          <span style={{ color: "var(--fg-0)" }}>{stats.toolUses}</span>
          <span style={{ color: "var(--fg-3)" }}>events</span>
          <span style={{ color: "var(--fg-0)" }}>{events.length}</span>
        </div>
      </div>

      {stats.recentFiles.length > 0 && (
        <div className="ctx-section">
          <h4>Recent files</h4>
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
              <span className="dl">{f.detail}</span>
            </div>
          ))}
        </div>
      )}

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
          {session.lastEventAt && (
            <>
              <dt>last event</dt>
              <dd>{relTime(session.lastEventAt)}</dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  );
}

interface DerivedStats {
  turns: number;
  toolUses: number;
  recentFiles: { path: string; action: string; detail: string }[];
}

function deriveStats(events: TranscriptEvent[]): DerivedStats {
  let turns = 0;
  let toolUses = 0;
  const fileMap = new Map<string, { action: string; detail: string; ts: number }>();

  for (const ev of events) {
    if (ev.kind === "user") turns++;
    if (ev.kind !== "assistant") continue;
    for (const b of ev.blocks) {
      if (b.type !== "tool_use") continue;
      toolUses++;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
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

  return { turns, toolUses, recentFiles };
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
