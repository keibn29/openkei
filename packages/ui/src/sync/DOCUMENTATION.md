# Sync architecture, event handling & store update rules

## Scope

This document covers the current client-side session/data architecture in `packages/ui/src/sync` and the rules for updating stores safely.

There are **two distinct session data scopes** in the UI:

1. **Directory-scoped sync stores**
   - Owned by the sync layer child stores created in `sync-context.tsx`
   - Source for per-directory live session/message/part/permission/question state
   - Backed by SSE / directory-scoped polling
   - Read via hooks like `useSessions()`, `useDirectorySync()`, `getSyncSessions()`, `getDirectoryState()`

2. **Global sessions cache**
   - Owned by `packages/ui/src/stores/useGlobalSessionsStore.ts`
   - Shared source of truth for the Sessions sidebar global lists and Session Retention cleanup
   - Holds:
     - global active sessions
     - global archived sessions
     - active sessions indexed by directory

These two scopes are intentionally different, but they are no longer equal peers for live UI truth.

### Why both exist

The directory-scoped sync stores are **not** a complete global view.

- They are created lazily per directory
- They only contain data for directories initialized in the current app session
- They are optimized for live per-directory domain data
- They do not maintain the complete global active+archived session view needed by the sidebar and retention settings

So:

- Use the **directory sync stores** for per-directory live session/message state
- Use the **global sessions store** for cold/global session coverage (especially archived pages and unopened directories)
- Use **aggregated child-store snapshots** for live session/status truth across already initialized directories

## Ownership map

| Layer / Store | Owns | Scope |
|---|---|---|
| child directory stores in `sync-context.tsx` | `session`, `message`, `part`, `permission`, `question`, etc. | One directory |
| `session-ui-store.ts` | Session selection, draft lifecycle, abort prompts, worktree metadata, SDK-facing action entrypoints | App UI state |
| `useGlobalSessionsStore.ts` | Global active sessions, global archived sessions, `sessionsByDirectory` | All opened project/worktree session lists |
| `viewport-store.ts` | Scroll anchors, session memory, loading indicators | App UI state |
| `input-store.ts` | Draft input state, attached files, synthetic parts | App UI state |
| `selection-store.ts` | Model/agent/variant selections | App UI state |
| `voice-store.ts` | Voice state | App UI state |

## Session list rules

### Directory-scoped session list

Use the directory-scoped sync store when the UI needs the live session list for the **current directory**.

Examples:

- current chat/session switching
- per-directory session/message bootstrap
- session/message/part SSE updates

### Global session list

Use `useGlobalSessionsStore` when the UI needs a **shared global session cache**.

Current consumers:

- `useSessionAutoCleanup.ts`

### Live cross-directory session/status view

Use the sync hooks backed by aggregated child stores when the UI needs **live truth** for sessions or statuses across all initialized directories.

Current consumers:

- `SessionSidebar.tsx`
- `SessionNodeItem.tsx`
- `Header.tsx`
- agent/session activity surfaces using `useGlobalSessionStatus()` / `useAllSessionStatuses()`

### Mutation responsibility

`useGlobalSessionsStore` is not maintained by SSE directly. It is kept correct by:

1. shared global fetch/reconciliation via `loadSessions()` / `refreshGlobalSessions()`
2. direct mutation from session actions after successful SDK calls:
   - create
   - title update
   - share
   - unshare
   - archive
   - delete
   - retention cleanup batch archive/delete

This keeps cold/global lists responsive without requiring a refetch after every change.

Live activity/status indicators must not depend on this cache. They must derive from aggregated child-store state.

## Session action rules

Session actions live in `session-actions.ts` and are the canonical place for SDK-calling session mutations that affect global session lists.

Rules:

1. If an action mutates session list membership or visible session metadata, update `useGlobalSessionsStore` there.
2. If an action targets a session by ID, resolve the **session's own directory**. Do not assume the current directory is correct.
3. `session-ui-store.ts` should delegate to `session-actions.ts` for these mutations instead of duplicating SDK calls.

Examples of global-store updates performed in `session-actions.ts`:

- `createSession()` -> `upsertSession(session)`
- `updateSessionTitle()` -> `upsertSession(result.data)`
- `shareSession()` / `unshareSession()` -> `upsertSession(result.data)`
- `archiveSession()` -> `archiveSessions([id], archivedAt)`
- `deleteSession()` -> `removeSessions([id])`

## Session revert and cascading policy

Reverting a session restores conversation and assistant state back to a chosen user message. OpenChamber uses a **timestamp-based cascading revert** policy for main sessions and their transitive child sessions (subagents):

### Policy details

1. **Cutoff, upper bound capture, and root reservation**:
   - The selected root message must be a valid user message with a positive, finite numeric `time.created` timestamp. This timestamp forms the `cutoff`.
   - The upper bound `capturedNow` (`Date.now()`) is recorded once at operation entry before any asynchronous operation begins. Bound is never advanced, and all message roles (including assistants) are validated against it.
   - If `cutoff > capturedNow`, or if any message timestamp is invalid/non-numeric, the operation fails closed immediately.
   - Root session is reserved synchronously via `lockRevertSessions([sessionId])` **before the first await** to prevent concurrent conflicting operations (such as unrevert or new revert) during planning.

2. **Transitive child discovery and reservation**:
   - Descendant sessions are discovered recursively via authoritative SDK `session.children({ sessionID, directory })` (merged with local cache).
   - Cycle detection and deduplication ensure acyclic traversal across multi-level hierarchies.
   - Child session directories are captured authoritatively from `child.directory` to prevent directory leakage across awaits.
   - Child plan locks are acquired safely avoiding same root reacquire, and all acquired locks are guaranteed to be released via `finally` across planning failure, abort failure, or execution failure.
   - **Topology recheck**: Hierarchy is rechecked before the mutation plan begins; if a new child session is discovered, the operation fails closed safe before any writes.
   - **Revert marker watch**: Descendant revert markers (`session.revert?.messageID`) are recorded at discovery and validated under reservations; if a descendant operation completed or changed its revert marker during planning, the plan is rejected as stale.

3. **Cascade targeting and prefix preservation**:
   - Each child session is scanned for user messages within the window: `cutoff <= time.created <= capturedNow`.
   - If matching user messages exist, the child is reverted from its **first user message chronologically** in that window.
   - Earlier turns before `cutoff` (e.g. Turn 1 prefix) are strictly preserved.
   - **No fallback**: If a child session has no user message in that window (e.g. an older child session whose assistant completed late, or a task completed prior to cutoff), the child is left **completely untouched**.

4. **Suffix revert and continuous revalidation**:
   - Because the SDK/backend reverts the message suffix from `messageID` onward, later concurrent messages cannot be isolated.
   - Any message created after `capturedNow` in a planned session triggers a fail-closed error to prevent silent data loss from concurrent writes. Existing message cleanup updates (e.g. abort completions with original `time.created <= capturedNow`) are preserved and do not trigger failure.
   - Raw message history is revalidated against `capturedNow`:
     a. **After abort/quiescence** for all planned targets before any writes occur.
     b. **Immediately before EACH revert execution** in the sequential loop.
   - If a concurrent write is detected after planning or during abort, the operation aborts with zero mutations. If a write is detected between child and root revert, the affected suffix is rejected and partial success of previously completed children is surfaced.

5. **Deterministic sequential execution**:
   - Planned sessions are executed sequentially in order of **deepest child first, shallower descendants next, and root session last** (never `Promise.all`).
   - Only planned sessions with pending reverts are checked and aborted if busy; preserved-only children are never aborted.

6. **Local send guard**:
   - In-flight revert operations directly guard local send actions (`optimisticSend` and `usePromptSubmit`), immediately rejecting prompt submissions on a session being reverted.

7. **Non-atomic partial failure**:
   - Reverts commit on the server per session. If a failure occurs midway through the plan, previously committed session reverts cannot and must not be rolled back with fake optimistic restores.
   - The failure explicitly surfaces the IDs of all successfully reverted sessions without logging sensitive content.

8. **Limitation note**:
   - Timestamp alignment operates on message creation times and assumes subagents finish within their parent turn. **Timestamp alignment does NOT guarantee concurrent ownership or filesystem overlap.**
   - **Cross-client atomicity**: A full cross-client atomic revert guarantee is not achievable without distributed server-side transactions or locking. Blocking local sends and revalidating raw history immediately prior to each revert closes local collision windows and minimizes external race windows, but a narrow race remains if an external client writes to a session in the milliseconds between pre-revert revalidation and server execution.

## The golden rule

When creating a draft in `handleDirectoryEvent`, **only clone the state fields the event will mutate**. Never spread all fields eagerly.

```typescript
// WRONG — clones everything, breaks referential equality for all subscribers
const draft = {
  ...current,
  session: [...current.session],
  message: { ...current.message },
  part: { ...current.part },
  permission: { ...current.permission },
  // ...
}

// RIGHT — only clone what this event type touches
const draft = { ...current }
switch (event.type) {
  case "message.part.delta":
    draft.part = { ...current.part }
    break
}
```

## Why this matters

Zustand skips re-renders when a selector returns the same reference (`Object.is`). If you spread `session: [...current.session]` but the event only modifies `part`, the `session` array gets a new reference. Every component using `useSessions()` re-renders for nothing.

During streaming, `message.part.delta` fires ~60 times/sec. Eagerly cloning all fields caused every subscriber in the entire app to re-render 60/sec — a 10x overhead. Targeted cloning reduced MessageList renders from ~1972 to ~296 per session.

## Event → field mapping

Keep this in sync with `handleDirectoryEvent` in `sync-context.tsx`:

| Event type | Fields to clone |
|---|---|
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part` |
| `session.diff` | `session_diff` |
| `session.status` | `session_status` |
| `todo.updated` | `todo` |
| `message.updated` | `message` |
| `message.removed` | `message`, `part` |
| `message.part.updated/removed/delta` | `part` |
| `vcs.branch.updated` | (none — mutates `draft.vcs` directly) |
| `permission.asked/replied` | `permission` |
| `question.asked/replied/rejected` | `question` |
| `lsp.updated` | `lsp` |

## Adding a new event type

1. Add the case to the event reducer (`event-reducer.ts`)
2. Add a corresponding case to the switch in `handleDirectoryEvent` (`sync-context.tsx`) that clones **only** the fields your reducer writes to
3. If your event fires frequently (more than a few times per second), verify that unrelated components don't re-render — check with the stream perf counters

## Selector hygiene

Select leaf values, not containers:

```typescript
// WRONG — returns entire Map/object, new reference on any mutation
useDirectorySync((s) => s.permission)

// RIGHT — returns the value for one key, stable unless that key changes
useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)
```

Same applies to `useStreamingStore` — select `.get(key)` not the Map itself.

## Store splitting pattern

### Why split

A single Zustand store with N properties means every subscriber's selector re-evaluates on every state change — even if the change is unrelated to what that subscriber reads. During streaming, `sessionMemoryState` updates ~60/sec. Before the split, all 68+ `useSessionUIStore` subscribers re-evaluated on each update. After splitting into focused stores, only `useViewportStore` subscribers (2-3 components) re-evaluate.

The optimization multiplies with targeted event cloning: fewer new references per event × fewer subscribers per store = dramatically less work per SSE frame.

### The stores

| Store | Owns | When it changes |
|-------|------|-----------------|
| `session-ui-store.ts` | Session selection, draft lifecycle, abort, worktree, SDK actions | Session switch, draft open/close |
| `voice-store.ts` | Voice connection/activity state | Voice toggle |
| `input-store.ts` | Pending input text, synthetic parts, attached files | User typing, file attach, revert/fork |
| `selection-store.ts` | Per-session model/agent/variant choices | Model/agent picker |
| `viewport-store.ts` | Scroll anchors, session memory state, sync status | Streaming, scroll, session switch |

### Rules for new UI state

1. **Never add to `session-ui-store`** unless it's session selection, draft lifecycle, or abort state
2. **Group by change frequency** — state that changes during streaming (viewport, memory) must not live with state that changes on user action (selections, input)
3. **Group by subscriber set** — if only 2 components read a value, it should be in a store that only those 2 components subscribe to
4. **Prefer a new store over growing an existing one** if the new state has different subscribers or change frequency
5. **Cross-store reads use `.getState()`** — actions in one store that need to read another store call `useOtherStore.getState()` (imperative, no subscription)

### Anti-patterns

```typescript
// WRONG — stuffing unrelated state into one store
const useEverythingStore = create(() => ({
  voiceMode: "idle",
  scrollAnchor: 0,
  selectedModel: null,
  pendingInput: "",
  // 20 more fields...
}))

// RIGHT — separate stores by concern + change frequency
const useVoiceStore = create(() => ({ voiceMode: "idle" }))
const useViewportStore = create(() => ({ scrollAnchor: 0 }))
const useSelectionStore = create(() => ({ selectedModel: null }))
const useInputStore = create(() => ({ pendingInput: "" }))
```
