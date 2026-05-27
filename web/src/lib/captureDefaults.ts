// Decides which project the capture modal should default to. Keeping this
// pure so the four ordering branches (explicit pick > current session's
// project > sole project > nothing) stay testable without rendering.

export interface PickArgs {
  selectedProjectKey: string | null;
  currentSessionProjectKey: string | null | undefined;
  projects: { key: string }[];
}

export function pickCaptureDefaultProject(args: PickArgs): string | null {
  if (args.selectedProjectKey) return args.selectedProjectKey;
  if (args.currentSessionProjectKey) return args.currentSessionProjectKey;
  if (args.projects.length === 1) return args.projects[0].key;
  return null;
}
