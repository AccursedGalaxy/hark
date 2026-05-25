// SVG icon set used across the new design.
// Single source of truth — components import from here.

const stroke = {
  fill: "none" as const,
  stroke: "currentColor" as const,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="2.4" {...stroke}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ChevIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" strokeWidth="2.2" {...stroke}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 11.5c0 4-4 3-12 6.5" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function TermIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="m4 7 4 5-4 5" />
      <path d="M12 19h8" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2.4" {...stroke}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function AttachIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <path d="m21 11-8.5 8.5a5 5 0 1 1-7-7L14 4a3.5 3.5 0 0 1 5 5L10.5 17.5a2 2 0 0 1-3-3L16 6" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <rect x="6" y="5" width="3.5" height="14" rx="1" />
      <rect x="14.5" y="5" width="3.5" height="14" rx="1" />
    </svg>
  );
}

export function ForkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="20" r="2" />
      <path d="M6 7v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7" />
      <path d="M12 13v5" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function ShareIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <path d="m16 6-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}

export function QuestionIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 1-1 1.7v.5" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function SparkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" strokeWidth="3.2" {...stroke}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...stroke}>
      <path d="M6 6l12 12M18 6l-12 12" />
    </svg>
  );
}

export function ClipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="M21 11.5l-8.5 8.5a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.67 3.67 0 0 1 5.19 5.19l-9.2 9.19a1.83 1.83 0 0 1-2.59-2.59L14.5 7" />
    </svg>
  );
}

export function CameraIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="1.6" {...stroke}>
      <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function PhotoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="1.6" {...stroke}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" fill="currentColor" />
      <path d="M3 17l5-5 4 4 3-3 6 6" />
    </svg>
  );
}

export function TextIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="1.6" {...stroke}>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="1.8" {...stroke}>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
