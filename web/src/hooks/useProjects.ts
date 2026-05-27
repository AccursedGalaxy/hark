import { useCallback, useEffect, useState } from "react";
import type { ProjectInfo } from "../lib/protocol";
import { fetchProjects } from "../lib/transport";

// Mirrors the polling pattern in useSessions, just on a 5s tick — projects
// change far less often than sessions, and the rail also calls refresh()
// after capture/install for fast feedback.
const POLL_MS = 5000;

export interface ProjectsApi {
  projects: ProjectInfo[];
  refresh: () => void;
}

export function useProjects(): ProjectsApi {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  const refresh = useCallback(() => {
    fetchProjects()
      .then(setProjects)
      .catch(() => {
        /* ignore — same liveness banner as useSessions covers transport */
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { projects, refresh };
}
