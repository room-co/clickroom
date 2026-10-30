// Thin wrapper around the same ULID generator `packages/db` already uses for
// every application-supplied primary key (`newId()`, backed by the `ulid`
// npm package — see `packages/db/src/client.ts`). Re-exported under this name
// so the streaming controller's `generateMessageId: ulid` reads naturally
// (mirrors the reference implementation's `ulid.ts`) while guaranteeing client and server agree on
// one id format — required for a tool-confirm resume to update the SAME
// `AiMessage` row instead of inserting a duplicate.
import { newId } from '@clickroom/db'

export function ulid(): string {
  return newId()
}
