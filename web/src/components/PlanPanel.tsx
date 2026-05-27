import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../lib/protocol";
import {
  fetchProjectPlan,
  installProject,
  type PlanResponse,
} from "../lib/transport";
import { tildeify } from "../lib/format";
import { Markdown } from "./Markdown";
import { BranchIcon, HistoryIcon } from "./icons";

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; plan: PlanResponse }
  | { kind: "error"; message: string };

export function PlanPanel({
  project,
  onBack,
  onCapture,
  onProjectChanged,
}: {
  project: ProjectInfo;
  // Narrow-mode back-to-rail handler; mirrors TopBar's onBack semantics.
  onBack?: () => void;
  onCapture: () => void;
  onProjectChanged: () => void;
}) {
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    fetchProjectPlan(project.key)
      .then((plan) => setState({ kind: "ok", plan }))
      .catch((err: unknown) => {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load plan",
        });
      });
  }, [project.key]);

  // Re-fetch on key change AND on planMtime advancement — other sessions
  // (or our own capture POST) update the file in-place, and useProjects'
  // poll will surface the new mtime which triggers this effect.
  useEffect(() => {
    load();
  }, [load, project.planMtime]);

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await installProject(project.key);
      onProjectChanged();
      load();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "install failed");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <header className="topbar" data-screen-label="PlanTopBar">
        {onBack && (
          <button
            type="button"
            className="back-btn"
            onClick={onBack}
            aria-label="Back to sessions"
          >
            ←
          </button>
        )}
        <div className="crumbs">
          <span className="here" title={project.root}>
            {project.name}
          </span>
          <span className="branch" style={{ marginLeft: 8 }}>
            <BranchIcon /> {tildeify(project.root)}
          </span>
        </div>

        <div className="spacer"></div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={load}
            title="Reload PLAN.md"
            aria-label="Refresh"
          >
            <HistoryIcon /> Refresh
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={onCapture}
            title="Capture a note to this project"
          >
            Capture
          </button>
        </div>
      </header>

      <div className="plan-pane" data-screen-label="PlanPane">
        {state.kind === "loading" && (
          <div className="plan-status">Loading PLAN.md…</div>
        )}

        {state.kind === "error" && (
          <div className="plan-status plan-error">
            Failed to load plan: {state.message}
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={load}>
                Try again
              </button>
            </div>
          </div>
        )}

        {state.kind === "ok" && state.plan.exists === false && (
          <div className="plan-setup">
            <h2>No PLAN.md yet</h2>
            <p>
              Hark hasn't set up project state for{" "}
              <code>{tildeify(project.root)}</code>. Setting up writes a
              starter <code>PLAN.md</code> and adds a small CLAUDE.md hook so
              Claude reads it automatically.
            </p>
            <div className="plan-setup-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => void install()}
                disabled={installing}
              >
                {installing ? "Setting up…" : "Set up project"}
              </button>
            </div>
            {installError && (
              <div className="plan-error" style={{ marginTop: 10 }}>
                {installError}
              </div>
            )}
          </div>
        )}

        {state.kind === "ok" && state.plan.exists && (
          <div className="plan-body">
            <Markdown source={state.plan.content} />
          </div>
        )}
      </div>
    </>
  );
}
