export type HookEventInput = {
  session_id: string;
  hook_event_name: string;
  message?: string;
  transcript_path?: string;
  cwd?: string;
};

export type SessionAttention = {
  needsAttention: boolean;
  lastEvent: string;
  lastEventAt: number;
  message?: string;
};

export type HookBroadcast = {
  sessionId: string;
} & SessionAttention;

export class HookState {
  private readonly bySession = new Map<string, SessionAttention>();

  record(input: HookEventInput): HookBroadcast {
    if (!input || typeof input.session_id !== "string" || !input.session_id) {
      throw new Error("hook event missing session_id");
    }
    const entry: SessionAttention = {
      needsAttention: true,
      lastEvent: input.hook_event_name,
      lastEventAt: Date.now(),
      message: input.message,
    };
    this.bySession.set(input.session_id, entry);
    return { sessionId: input.session_id, ...entry };
  }

  clear(sessionId: string): void {
    const cur = this.bySession.get(sessionId);
    if (!cur) return;
    this.bySession.set(sessionId, { ...cur, needsAttention: false });
  }

  get(sessionId: string): SessionAttention | undefined {
    return this.bySession.get(sessionId);
  }

  snapshot(): Record<string, SessionAttention> {
    const out: Record<string, SessionAttention> = {};
    for (const [k, v] of this.bySession) out[k] = { ...v };
    return out;
  }
}
