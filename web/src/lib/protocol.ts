// Wire protocol shared with the Express host. The single source of truth
// lives at src/shared/protocol.ts; this file is a re-export so web modules
// keep their familiar import path (`../lib/protocol`).
//
// Don't add types here — put them in src/shared/protocol.ts so the server
// sees them too.
export * from "../../../src/shared/protocol";
