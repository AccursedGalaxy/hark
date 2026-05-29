import { useCallback, useEffect, useState } from "react";
import {
  fetchOrchestration,
  fetchOrchestrations,
  type OrchestrationDetail,
  type OrchestrationWithSummary,
} from "../lib/transport";

// Polls the orchestration list (and, when one is selected, its detail) on the
// same cadence as the rest of hark. Orchestrations change as agents take turns
// and the reconcile loop refreshes metrics, so a short poll keeps the
// dashboard live without an extra SSE channel.
const POLL_MS = 3000;

export interface OrchestrationsApi {
  orchestrations: OrchestrationWithSummary[];
  selected: string | null;
  setSelected: (id: string | null) => void;
  detail: OrchestrationDetail | null;
  refresh: () => void;
}

export function useOrchestrations(): OrchestrationsApi {
  const [orchestrations, setOrchestrations] = useState<
    OrchestrationWithSummary[]
  >([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrchestrationDetail | null>(null);

  const refresh = useCallback(() => {
    fetchOrchestrations()
      .then(setOrchestrations)
      .catch(() => {
        /* ignore — liveness banner covers transport errors */
      });
    if (selected) {
      fetchOrchestration(selected)
        .then(setDetail)
        .catch(() => {});
    }
  }, [selected]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Clear stale detail immediately when the selection changes, so the panel
  // doesn't flash the previous orchestration's agents before the fetch lands.
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    setDetail((d) => (d && d.orchestration.id === selected ? d : null));
  }, [selected]);

  return { orchestrations, selected, setSelected, detail, refresh };
}
