/**
 * Session actions — SDK-calling operations for session management.
 * Replaces the action methods from the old useSessionStore.
 */

import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"
import { Binary } from "./binary"
import { useSessionUIStore } from "./session-ui-store"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { opencodeClient } from "@/lib/opencode/client"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { usePermissionStore } from "@/stores/permissionStore"
import { registerSessionDirectory } from "./sync-refs"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { clearSessionPrefetch } from "./session-prefetch-cache"
import {
  getSessionMutationVersion,
  markSessionDeleted,
} from "./session-mutation-version"
import {
  buildRevertPlan,
  isRevertInflight,
  lockRevertSessions,
  unlockRevertSessions,
  assertNoConcurrentMessagesAfterNow,
  fetchAllSessionMessages,
  discoverTransitiveChildren,
} from "./revert-plan"

// Reference set by SyncProvider — allows actions to access SDK and stores
let _sdk: OpencodeClient | null = null
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
let _optimisticAdd: ((input: { sessionID: string; message: Message; parts: Part[] }) => void) | null = null
let _optimisticRemove: ((input: { sessionID: string; messageID: string }) => void) | null = null

export function setActionRefs(
  sdk: OpencodeClient,
  childStores: ChildStoreManager,
  getDirectory: () => string,
) {
  _sdk = sdk
  _childStores = childStores
  _getDirectory = getDirectory
}

export function setOptimisticRefs(
  add: (input: { sessionID: string; message: Message; parts: Part[] }) => void,
  remove: (input: { sessionID: string; messageID: string }) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
}

function sdk() {
  if (!_sdk) throw new Error("SDK not initialized — is SyncProvider mounted?")
  return _sdk
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

// Wait briefly for the pipeline to re-establish connection before failing a
// send. Transient reconnects (heartbeat race, WS→SSE fallback, brief network
// blip) otherwise surface as a hard "Connection lost" toast even though the
// pipeline recovers within a second. While waiting, run bounded health probes
// inside the same grace window so stale disconnected state can recover quickly.
const CONNECTION_GRACE_MS = 2000
export async function waitForConnectionOrThrow(): Promise<void> {
  const deadline = Date.now() + CONNECTION_GRACE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

function getSessionDirectory(sessionId: string): string | undefined {
  return useSessionUIStore.getState().getDirectoryForSession(sessionId) || dir()
}

function getDirectoryStore(directory?: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  const resolvedDirectory = directory || _getDirectory()
  if (!resolvedDirectory) throw new Error("No current directory")
  return _childStores.ensureChild(resolvedDirectory)
}

function getSessionReplyClient(sessionId?: string): OpencodeClient {
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null
  if (directory) {
    return opencodeClient.getScopedSdkClient(directory)
  }
  return sdk()
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.question
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string }> | undefined>) {
      if (requests?.some((request) => request.id === requestId)) {
        return directory
      }
    }
  }

  const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.question ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

function getRequestReplyClient(
  type: "permission" | "question",
  sessionId: string,
  requestId: string,
): OpencodeClient {
  const requestDirectory = resolveDirectoryForBlockingRequest(type, sessionId, requestId)
  if (requestDirectory) {
    return opencodeClient.getScopedSdkClient(requestDirectory)
  }
  return getSessionReplyClient(sessionId)
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  parentID?: string | null,
): Promise<Session | null> {
  try {
    const result = await sdk().session.create({
      directory: directoryOverride ?? dir(),
      title,
      parentID: parentID ?? undefined,
    })
    const session = result.data
    if (!session) return null

      const sessionDirectory = (session as { directory?: string }).directory ?? directoryOverride ?? null
      // Pre-populate routing index so SSE events arriving before session.created
      // can be routed to the correct child store
      if (sessionDirectory) {
        registerSessionDirectory(session.id, sessionDirectory)
      }
      useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory)
      useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
      useGlobalSessionsStore.getState().upsertSession(session)
      await usePermissionStore.getState().setSessionAutoAccept(session.id, true)
      return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

/** Optimistically remove a session from the child store list. Returns previous list for rollback. */
function optimisticRemoveSession(sessionId: string, directory?: string): Session[] | null {
  const store = getDirectoryStore(directory)
  const current = store.getState()
  const sessions = [...current.session]
  const result = Binary.search(sessions, sessionId, (s) => s.id)
  let foundIndex = result.found ? result.index : -1
  if (foundIndex === -1) {
    foundIndex = sessions.findIndex((s) => s.id === sessionId)
  }
  if (foundIndex !== -1) {
    const snapshot = current.session
    sessions.splice(foundIndex, 1)
    store.setState({ session: sessions })
    return snapshot
  }
  return null
}

/**
 * Discover descendant session IDs following parentID relationships rooted at rootIds.
 * Returns descendants in post-order (deepest descendants first).
 * Never touches another main session tree; strictly uses parentID.
 */
export function findDescendantSessionIds(
  rootIds: Iterable<string>,
  knownSessions: Iterable<Session>,
): string[] {
  const rootSet = new Set(rootIds)
  const childrenByParent = new Map<string, Session[]>()
  for (const session of knownSessions) {
    if (session.parentID) {
      const list = childrenByParent.get(session.parentID) ?? []
      list.push(session)
      childrenByParent.set(session.parentID, list)
    }
  }

  const orderedDescendantIds: string[] = []
  const visited = new Set<string>(rootSet)

  const traverse = (parentId: string) => {
    const children = childrenByParent.get(parentId) ?? []
    for (const child of children) {
      if (!visited.has(child.id)) {
        visited.add(child.id)
        traverse(child.id)
        orderedDescendantIds.push(child.id)
      }
    }
  }

  for (const rootId of rootSet) {
    traverse(rootId)
  }

  return Array.from(new Set(orderedDescendantIds))
}

function isSessionNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const err = error as Record<string, unknown>
  if (err.status === 404 || err.statusCode === 404 || err.code === 404) return true

  const res = err.response as Record<string, unknown> | undefined
  if (res && (res.status === 404 || res.statusCode === 404)) return true

  const cause = err.cause as Record<string, unknown> | undefined
  if (cause) {
    if (cause.status === 404 || cause.statusCode === 404 || cause.code === 404) return true
    const causeRes = cause.response as Record<string, unknown> | undefined
    if (causeRes && (causeRes.status === 404 || causeRes.statusCode === 404)) return true
  }

  return false
}

export async function deleteSessions(
  ids: string[],
  _options?: Record<string, unknown>,
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  void _options
  const rawIds = Array.from(new Set(ids.filter(Boolean)))
  if (rawIds.length === 0) {
    return { deletedIds: [], failedIds: [] }
  }

  // 1. Gather all currently known sessions across child stores and global stores
  const sessionMap = new Map<string, Session>()
  const childStoreBySessionId = new Map<string, string>()

  if (_childStores) {
    for (const [dir, store] of _childStores.children) {
      for (const session of store.getState().session) {
        sessionMap.set(session.id, session)
        childStoreBySessionId.set(session.id, dir)
      }
    }
  }
  const globalStore = useGlobalSessionsStore.getState()
  for (const session of globalStore.activeSessions) {
    if (!sessionMap.has(session.id)) sessionMap.set(session.id, session)
  }
  for (const session of globalStore.archivedSessions) {
    if (!sessionMap.has(session.id)) sessionMap.set(session.id, session)
  }

  // 2. Discover all descendants in the parentID trees rooted at rawIds
  const descendantIds = findDescendantSessionIds(rawIds, sessionMap.values())
  const allTargetIds = Array.from(new Set([...descendantIds, ...rawIds]))
  const allTargetIdSet = new Set(allTargetIds)

  // 3. PREFLIGHT: Capture authoritative directory per target BEFORE any store removal or await
  // Sources:
  // a) Matching child store key
  // b) Session UI store registry / attachment
  // c) session.directory / project.worktree from session object
  const targetDirectoryMap = new Map<string, string>()
  const ui = useSessionUIStore.getState()

  for (const id of allTargetIds) {
    let dir: string | null = childStoreBySessionId.get(id) ?? null
    if (!dir) {
      const session = sessionMap.get(id)
      if (session) {
        const s = session as { directory?: string | null; project?: { worktree?: string | null } | null }
        if (s.directory) {
          dir = s.directory
        } else if (s.project?.worktree) {
          dir = s.project.worktree
        }
      }
    }
    if (!dir) {
      dir = ui.getDirectoryForSession(id)
    }

    if (!dir) {
      // Fail closed: abort before any optimistic removal or await!
      console.error(`[session-actions] Cannot resolve authoritative directory for session ${id}; failing closed`)
      return { deletedIds: [], failedIds: allTargetIds }
    }
    targetDirectoryMap.set(id, dir)
  }

  // 4. Children-first server delete order: deepest descendants first, then roots last
  const nonRootDescendants = descendantIds.filter((id) => !rawIds.includes(id))
  const finalDeleteOrder = Array.from(
    new Set([
      ...nonRootDescendants,
      ...rawIds.filter((id) => descendantIds.includes(id)),
      ...rawIds.filter((id) => !descendantIds.includes(id)),
    ]),
  )

  // 5. Clear currentSessionId synchronously if it is in the removed subtree
  if (ui.currentSessionId && allTargetIdSet.has(ui.currentSessionId)) {
    ui.setCurrentSession(null)
  }

  // 6. Optimistically remove from global store synchronously before any await
  globalStore.removeSessions(allTargetIdSet)
  for (const id of allTargetIds) {
    markSessionDeleted(id)
  }

  // 7. Optimistically remove from child directory stores and caches synchronously before any await
  // DO NOT mutate sessionTotal; leave event reducer / SSE authoritative to prevent double decrement!
  if (_childStores) {
    for (const [dir, store] of _childStores.children) {
      const state = store.getState()
      const hasMatchingSessions = state.session.some((s) => allTargetIdSet.has(s.id))
      const matchingCacheIds = new Set<string>()
      for (const id of allTargetIds) {
        if (
          state.message[id] ||
          state.part[id] ||
          state.todo[id] ||
          state.session_status[id] ||
          state.session_diff[id] ||
          state.permission[id] ||
          state.question[id]
        ) {
          matchingCacheIds.add(id)
        }
      }

      if (!hasMatchingSessions && matchingCacheIds.size === 0) {
        // Untouched branch: preserve reference per performance rules
        continue
      }

      const nextSession = hasMatchingSessions
        ? state.session.filter((s) => !allTargetIdSet.has(s.id))
        : state.session

      const patch: Partial<State> = {
        session: nextSession,
      }

      if (matchingCacheIds.size > 0) {
        const nextMessage = { ...state.message }
        const nextPart = { ...state.part }
        const nextTodo = { ...state.todo }
        const nextStatus = { ...state.session_status }
        const nextDiff = { ...state.session_diff }
        const nextPermission = { ...state.permission }
        const nextQuestion = { ...state.question }

        for (const id of matchingCacheIds) {
          delete nextMessage[id]
          delete nextPart[id]
          delete nextTodo[id]
          delete nextStatus[id]
          delete nextDiff[id]
          delete nextPermission[id]
          delete nextQuestion[id]
        }

        for (const key of Object.keys(nextPart)) {
          const parts = nextPart[key]
          if (parts?.some((p) => allTargetIdSet.has((p as { sessionID?: string })?.sessionID ?? ""))) {
            delete nextPart[key]
          }
        }

        patch.message = nextMessage
        patch.part = nextPart
        patch.todo = nextTodo
        patch.session_status = nextStatus
        patch.session_diff = nextDiff
        patch.permission = nextPermission
        patch.question = nextQuestion
      }

      store.setState(patch)
      clearSessionPrefetch(dir, allTargetIdSet)
    }
  }

  // 8. Execute server deletes in children-first order using immutable captured directory map
  const directlyDeletedIds = new Set<string>()
  const directlyFailedIds = new Set<string>()

  for (const id of finalDeleteOrder) {
    const sessionDirectory = targetDirectoryMap.get(id)!
    try {
      const response = await sdk().session.delete({ sessionID: id, directory: sessionDirectory })
      if (response && "error" in response && response.error) {
        if (isSessionNotFound(response.error) || response.response?.status === 404) {
          directlyDeletedIds.add(id)
        } else {
          console.error(`[session-actions] deleteSession failed for ${id}:`, response.error)
          directlyFailedIds.add(id)
        }
      } else if (response && "data" in response && response.data === false) {
        directlyFailedIds.add(id)
      } else {
        directlyDeletedIds.add(id)
      }
    } catch (error) {
      if (isSessionNotFound(error)) {
        directlyDeletedIds.add(id)
      } else {
        console.error(`[session-actions] deleteSession failed for ${id}:`, error)
        directlyFailedIds.add(id)
      }
    }
  }

  // 9. Cascade semantics: If an ancestor delete succeeded, all of its descendants
  // are confirmed deleted by cascade, regardless of earlier child response. Never restore those.
  const confirmedDeletedIds = new Set<string>(directlyDeletedIds)
  for (const id of directlyDeletedIds) {
    const cascadedChildIds = findDescendantSessionIds([id], sessionMap.values())
    for (const cid of cascadedChildIds) {
      confirmedDeletedIds.add(cid)
    }
  }

  // Candidates for restore: targets that failed AND are not covered by any successful ancestor
  const unconfirmedFailedIds = allTargetIds.filter((id) => !confirmedDeletedIds.has(id))

  // 10. For failed targets not covered by a successful ancestor, reconcile authoritative existence
  // via sdk().session.get() with captured directory before restoring.
  // 404 means deleted. Restore only authoritative server records that still exist.
  const finalDeletedIds = new Set<string>(confirmedDeletedIds)
  const finalFailedIds = new Set<string>()

  for (const id of unconfirmedFailedIds) {
    const sessionDirectory = targetDirectoryMap.get(id)!
    const capturedVersion = getSessionMutationVersion(id)
    try {
      const getRes = await sdk().session.get({ sessionID: id, directory: sessionDirectory })
      if (getRes && "error" in getRes && getRes.error) {
        if (isSessionNotFound(getRes.error) || getRes.response?.status === 404) {
          // 404 means confirmed deleted on server!
          finalDeletedIds.add(id)
        } else {
          finalFailedIds.add(id)
        }
      } else if (getRes && "data" in getRes && getRes.data) {
        // Authoritative record still exists on server:
        finalFailedIds.add(id)

        // Generation / tombstone check:
        // If an SSE event (session.deleted or session.updated) arrived while GET was pending,
        // generation will have changed; never apply this stale GET result!
        if (getSessionMutationVersion(id) !== capturedVersion) {
          continue
        }

        const authoritativeSession = getRes.data
        const serverUpdated = authoritativeSession.time?.updated ?? authoritativeSession.time?.created ?? 0

        // Restore to global store only if no newer record already exists in global store
        const currentGlobalState = useGlobalSessionsStore.getState()
        const existingGlobal = currentGlobalState.activeSessions.find((s) => s.id === id)
          ?? currentGlobalState.archivedSessions.find((s) => s.id === id)
        const existingGlobalUpdated = existingGlobal?.time?.updated ?? existingGlobal?.time?.created ?? 0

        if (!existingGlobal || serverUpdated > existingGlobalUpdated) {
          currentGlobalState.upsertSession(authoritativeSession)
        }

        // Restore to child store maintaining unique sorted invariant via Binary.search
        // without overwriting newer existing record
        if (_childStores) {
          const store = _childStores.children.get(sessionDirectory)
          if (store) {
            const currentSessions = [...store.getState().session]
            const search = Binary.search(currentSessions, authoritativeSession.id, (s) => s.id)
            if (search.found) {
              const current = currentSessions[search.index]
              const currentUpdated = current.time?.updated ?? current.time?.created ?? 0
              if (serverUpdated > currentUpdated) {
                currentSessions[search.index] = authoritativeSession
                store.setState({ session: currentSessions })
              }
            } else {
              currentSessions.splice(search.index, 0, authoritativeSession)
              store.setState({ session: currentSessions })
            }
          }
        }
      } else {
        finalFailedIds.add(id)
      }
    } catch (error) {
      if (isSessionNotFound(error)) {
        finalDeletedIds.add(id)
      } else {
        // Ambiguous / network error: do NOT resurrect stale snapshot; surface failure explicitly
        finalFailedIds.add(id)
      }
    }
  }

  if (finalFailedIds.size > 0) {
    void useGlobalSessionsStore.getState().loadSessions().catch(() => {})
  }

  return {
    deletedIds: allTargetIds.filter((id) => finalDeletedIds.has(id)),
    failedIds: allTargetIds.filter((id) => finalFailedIds.has(id)),
  }
}

export async function deleteSession(sessionId: string, options?: Record<string, unknown>): Promise<boolean> {
  const result = await deleteSessions([sessionId], options)
  return result.deletedIds.includes(sessionId)
}

/** Delete a session specifying which directory it lives in. Used by agent groups for cross-directory deletes. */
export async function deleteSessionInDirectory(sessionId: string, directory: string): Promise<boolean> {
  if (directory) {
    registerSessionDirectory(sessionId, directory)
  }
  return deleteSession(sessionId)
}

export async function archiveSession(sessionId: string): Promise<boolean> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const snapshot = optimisticRemoveSession(sessionId, sessionDirectory)
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) {
    ui.setCurrentSession(null)
  }
  try {
    const archivedAt = Date.now()
    await sdk().session.update({ sessionID: sessionId, directory: sessionDirectory, time: { archived: archivedAt } })
    useGlobalSessionsStore.getState().archiveSessions([sessionId], archivedAt)
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    if (snapshot) getDirectoryStore(sessionDirectory).setState({ session: snapshot })
    return false
  }
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.update({ sessionID: sessionId, directory: sessionDirectory, title })
  if (result.data) {
    useGlobalSessionsStore.getState().upsertSession(result.data)
    // Optimistically update child store so sidebar updates immediately
    const store = getDirectoryStore(sessionDirectory)
    const current = store.getState()
    const sessions = [...current.session]
    const idx = Binary.search(sessions, sessionId, (s) => s.id)
    if (idx.found) {
      sessions[idx.index] = result.data
      store.setState({ session: sessions })
    }
  }
}

export async function shareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.share({ sessionID: sessionId, directory: sessionDirectory })
  if (result.data) {
    useGlobalSessionsStore.getState().upsertSession(result.data)
    // Optimistically update child store so sidebar updates immediately
    const store = getDirectoryStore(sessionDirectory)
    const current = store.getState()
    const sessions = [...current.session]
    const idx = Binary.search(sessions, sessionId, (s) => s.id)
    if (idx.found) {
      sessions[idx.index] = result.data
      store.setState({ session: sessions })
    }
  }
  return result.data ?? null
}

export async function unshareSession(sessionId: string): Promise<Session | null> {
  const sessionDirectory = getSessionDirectory(sessionId)
  const result = await sdk().session.unshare({ sessionID: sessionId, directory: sessionDirectory })
  if (result.data) {
    useGlobalSessionsStore.getState().upsertSession(result.data)
    // Optimistically update child store so sidebar updates immediately
    const store = getDirectoryStore(sessionDirectory)
    const current = store.getState()
    const sessions = [...current.session]
    const idx = Binary.search(sessions, sessionId, (s) => s.id)
    if (idx.found) {
      sessions[idx.index] = result.data
      store.setState({ session: sessions })
    }
  }
  return result.data ?? null
}

// ---------------------------------------------------------------------------
// Optimistic message send — insert user message before API call, rollback on error
// ---------------------------------------------------------------------------

// ID generator matching OpenCode's Identifier.ascending format.
// Uses BigInt(timestamp) * 0x1000 + counter, encoded as 6 hex bytes + random base62.
// This ensures client-generated IDs sort correctly with server-generated ones.
let lastIdTimestamp = 0
let idCounter = 0

function ascendingId(prefix: string): string {
  const now = Date.now()
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now
    idCounter = 0
  }
  idCounter += 1

  const value = BigInt(now) * BigInt(0x1000) + BigInt(idCounter)
  const bytes = new Uint8Array(6)
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }

  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let rand = ""
  for (let i = 0; i < 14; i++) {
    rand += chars[Math.floor(Math.random() * 62)]
  }

  return `${prefix}_${hex}${rand}`
}

/**
 * Wraps an async send operation with optimistic user-message insertion.
 * Uses useSync()'s optimistic infrastructure — message + parts are inserted
 * into the store AND registered in the shadow Map. mergeOptimisticPage
 * handles deduplication when the server echoes back the real message.
 */
export async function optimisticSend(input: {
  sessionId: string
  content: string
  providerID: string
  modelID: string
  agent?: string
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  /** The actual API call — receives the optimistic messageID so the server can use the same ID */
  send: (messageID: string) => Promise<void>
}): Promise<void> {
  if (isRevertInflight(input.sessionId)) {
    throw new Error(`Cannot send message: revert operation in progress for session ${input.sessionId}`)
  }

  if (!_optimisticAdd || !_optimisticRemove) {
    throw new Error("Optimistic refs not set — is useSync() mounted?")
  }

  await waitForConnectionOrThrow()

  if (isRevertInflight(input.sessionId)) {
    throw new Error(`Cannot send message: revert operation in progress for session ${input.sessionId}`)
  }

  const store = dirStore()
  const messageID = ascendingId("msg")
  const textPartId = ascendingId("prt")

  const optimisticParts: Part[] = [
    { id: textPartId, type: "text", text: input.content } as Part,
  ]
  if (input.files) {
    for (const f of input.files) {
      optimisticParts.push({ id: ascendingId("prt"), type: "file", mime: f.mime, url: f.url, filename: f.filename } as Part)
    }
  }

  const optimisticMessage = {
    id: messageID,
    role: "user" as const,
    sessionID: input.sessionId,
    parentID: "",
    modelID: input.modelID,
    providerID: input.providerID,
    system: "",
    agent: input.agent ?? "",
    model: `${input.providerID}/${input.modelID}`,
    metadata: {} as Record<string, unknown>,
    time: { created: Date.now(), completed: 0 },
  } as unknown as Message

  // Insert into store + register in shadow Map (for mergeOptimisticPage cleanup)
  _optimisticAdd({
    sessionID: input.sessionId,
    message: optimisticMessage,
    parts: optimisticParts,
  })

  // Set busy status
  const current = store.getState()
  store.setState({
    session_status: {
      ...current.session_status,
      [input.sessionId]: { type: "busy" as const },
    },
  })

  try {
    await input.send(messageID)
  } catch (error) {
    // Rollback via optimistic infrastructure
    _optimisticRemove({
      sessionID: input.sessionId,
      messageID,
    })
    const s = store.getState()
    store.setState({
      session_status: {
        ...s.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  try {
    await sdk().session.abort({ sessionID: sessionId, directory: dir() })
  } catch (error) {
    console.error("[session-actions] abort failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: response,
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Permission reply failed")
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("permission", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("permission", sessionId, requestId).permission.reply({
    requestID: requestId,
    reply: "reject",
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Permission dismissal failed")
  }
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("question", sessionId, requestId).question.reply({
    requestID: requestId,
    answers: answers as Array<Array<string>>,
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Question reply failed")
  }
}

export async function rejectQuestion(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = resolveDirectoryForBlockingRequest("question", sessionId, requestId)
    || getSessionDirectory(sessionId)
    || dir()
  const result = await getRequestReplyClient("question", sessionId, requestId).question.reject({
    requestID: requestId,
    ...(directory ? { directory } : {}),
  })
  if (!result.data) {
    throw new Error("Question rejection failed")
  }
}

// ---------------------------------------------------------------------------
// Message history
// ---------------------------------------------------------------------------

function reconcileRevertedSession(directory: string | undefined, session: Session) {
  useGlobalSessionsStore.getState().upsertSession(session)
  if (_childStores) {
    const dirToUse = directory || _getDirectory()
    if (dirToUse) {
      const store = _childStores.ensureChild(dirToUse)
      const current = store.getState()
      const sessions = [...current.session]
      const idx = sessions.findIndex((s) => s.id === session.id)
      if (idx >= 0) {
        sessions[idx] = session
        store.setState({ session: sessions })
      }
    }
  }
}

/**
 * Revert to a specific user message.
 *
 * Implements timestamp-based cascading revert:
 * 1. Captures cutoff from root target message and upper bound Date.now at entry before await.
 * 2. Scans all transitive child sessions via SDK session.children.
 * 3. Reverts each child only from its FIRST USER MESSAGE where cutoff <= time.created <= capturedNow.
 * 4. Preserves prefix from turn 1. Children with no matching user message are untouched.
 * 5. Aborts planned busy sessions if necessary (never preserved-only children).
 * 6. Executes sequentially: deepest children first, root parent last.
 * 7. Reconciles each successful session with fresh store refs without fake rollbacks or optimistic data deletion.
 * 8. Restores prompt only after root confirmed success and session is still active.
 */
export async function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  // Capture upper bound and root directory ONCE at entry before any await
  const capturedNow = Date.now()
  const capturedRootDir = getSessionDirectory(sessionId) || dir()

  // 1. Reserve root BEFORE first await
  if (isRevertInflight(sessionId)) {
    throw new Error(`Conflicting revert/unrevert operation already in progress for session ${sessionId}`)
  }
  lockRevertSessions([sessionId])
  const lockedSessionIds = new Set<string>([sessionId])

  try {
    // Collect local cached sessions to ensure SDK + local cache union
    const localDescendants: Session[] = []
    if (_childStores) {
      for (const store of _childStores.children.values()) {
        localDescendants.push(...store.getState().session)
      }
    }

    // 2. Discover transitive children
    const initialChildren = await discoverTransitiveChildren(
      sdk(),
      sessionId,
      capturedRootDir,
      localDescendants,
    )

    // Snapshot initial revert markers of discovered descendants
    const initialRevertMarkers = new Map<string, string | undefined>()
    for (const child of initialChildren) {
      initialRevertMarkers.set(child.id, child.revert?.messageID)
    }

    // 3. Acquire child plan locks safely, avoiding same root reacquire and deduplicating
    const childIdsToLock = Array.from(new Set(initialChildren.map((c) => c.id))).filter(
      (id) => !lockedSessionIds.has(id),
    )
    if (childIdsToLock.length > 0) {
      lockRevertSessions(childIdsToLock)
      for (const id of childIdsToLock) {
        lockedSessionIds.add(id)
      }
    }

    // 4. Recheck topology: fail safe if new child discovered before mutation plan
    const recheckedChildren = await discoverTransitiveChildren(
      sdk(),
      sessionId,
      capturedRootDir,
      localDescendants,
    )
    for (const child of recheckedChildren) {
      if (!lockedSessionIds.has(child.id)) {
        throw new Error(
          `Topology changed: new child session ${child.id} discovered before execution plan`
        )
      }
    }

    // 5. Watch changed current revert marker: reject stale completed descendant operations
    for (const child of recheckedChildren) {
      const initialMarker = initialRevertMarkers.get(child.id)
      const currentMarker = child.revert?.messageID
      if (currentMarker !== initialMarker) {
        throw new Error(
          `Stale revert plan: descendant session ${child.id} revert marker changed during planning`
        )
      }
    }

    // 6. Build execution plan under reservations
    const plan = await buildRevertPlan({
      client: sdk(),
      rootSessionId: sessionId,
      rootMessageId: messageId,
      rootDirectory: capturedRootDir,
      capturedNow,
      localDescendants,
      discoveredChildren: recheckedChildren,
    })

    // 7. Abort planned busy sessions if necessary (never preserved-only child)
    for (const target of plan.targets) {
      const targetStore = target.directory ? _childStores?.ensureChild(target.directory) : dirStore()
      const status = targetStore?.getState().session_status[target.sessionID]
      if (status && status.type !== "idle") {
        const abortRes = await sdk().session.abort({
          sessionID: target.sessionID,
          directory: target.directory,
        })
        if (abortRes.error) {
          const msg = (abortRes.error as { message?: string })?.message || "Abort error"
          throw new Error(`Failed to abort busy session ${target.sessionID}: ${msg}`)
        }
        if (abortRes.data === false) {
          throw new Error(`Failed to abort busy session ${target.sessionID}: abort returned false`)
        }
        if (targetStore) {
          targetStore.setState({
            session_status: {
              ...targetStore.getState().session_status,
              [target.sessionID]: { type: "idle" },
            },
          })
        }
      }
    }

    // 8. Revalidate raw history after abort/quiescence for ALL planned targets before any writes
    for (const target of plan.targets) {
      const quiescenceResult = await fetchAllSessionMessages(sdk(), target.sessionID, target.directory)
      assertNoConcurrentMessagesAfterNow(quiescenceResult.messages, target.sessionID, capturedNow)
    }

    // 9. Deterministic sequential execution: deepest-child first, then root parent
    const successfulSessionIds: string[] = []
    for (const target of plan.targets) {
      try {
        // Revalidate raw history immediately before EACH revert with original capturedNow
        const preRevertResult = await fetchAllSessionMessages(sdk(), target.sessionID, target.directory)
        assertNoConcurrentMessagesAfterNow(preRevertResult.messages, target.sessionID, capturedNow)

        const stillExists = preRevertResult.messages.some((m) => m.id === target.messageID)
        if (!stillExists) {
          throw new Error(`Target message ${target.messageID} no longer exists in session ${target.sessionID}`)
        }

        const result = await sdk().session.revert({
          sessionID: target.sessionID,
          directory: target.directory,
          messageID: target.messageID,
        })

        if (result.error) {
          const msg = (result.error as { message?: string })?.message || "Revert error"
          throw new Error(msg)
        }
        if (!result.data) {
          throw new Error(`Missing revert response data for session ${target.sessionID}`)
        }
        if (result.data.id !== target.sessionID) {
          throw new Error(`Revert session ID mismatch: expected ${target.sessionID}, got ${result.data.id}`)
        }
        if (result.data.revert?.messageID !== target.messageID) {
          throw new Error(
            `Revert message ID mismatch for session ${target.sessionID}: expected ${target.messageID}, got ${result.data.revert?.messageID}`
          )
        }

        reconcileRevertedSession(target.directory, result.data)
        successfulSessionIds.push(target.sessionID)
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (successfulSessionIds.length > 0) {
          throw new Error(
            `Partial revert failure: successfully reverted sessions [${successfulSessionIds.join(", ")}], failed on session ${target.sessionID}: ${errorMsg}`
          )
        }
        throw err
      }
    }

    // 10. Prompt restoration only after root confirmed success and same current session still active
    if (useSessionUIStore.getState().currentSessionId === sessionId) {
      const storeParts = _childStores?.children.get(capturedRootDir || "")?.getState().part[messageId] ?? []
      const parts = storeParts.length > 0 ? storeParts : plan.rootTargetParts
      const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
      const messageText = textParts
        .map((p) => ((p as { text?: string }).text || (p as { content?: string }).content || ""))
        .join("\n")
        .trim()

      if (messageText) {
        useInputStore.setState({
          pendingInputText: messageText,
          pendingInputMode: "replace" as const,
        })
      }
    }
  } finally {
    unlockRevertSessions(Array.from(lockedSessionIds))
  }
}

/**
 * Unrevert — restore all previously reverted messages.
 * Aborts if busy, merges result, and retains message history for recovery.
 */
export async function unrevertSession(sessionId: string): Promise<void> {
  if (isRevertInflight(sessionId)) {
    throw new Error(`Conflicting revert/unrevert operation already in progress for session ${sessionId}`)
  }
  lockRevertSessions([sessionId])

  try {
    const sessionDirectory = getSessionDirectory(sessionId) || dir()
    const store = sessionDirectory ? _childStores?.ensureChild(sessionDirectory) : dirStore()

    // Abort if busy
    const status = store?.getState().session_status[sessionId]
    if (status && status.type !== "idle") {
      const abortRes = await sdk().session.abort({ sessionID: sessionId, directory: sessionDirectory })
      if (abortRes.error) {
        const msg = (abortRes.error as { message?: string })?.message || "Abort error"
        throw new Error(`Failed to abort session ${sessionId} before unrevert: ${msg}`)
      }
      if (abortRes.data === false) {
        throw new Error(`Failed to abort session ${sessionId} before unrevert: abort returned false`)
      }
      if (store) {
        store.setState({
          session_status: {
            ...store.getState().session_status,
            [sessionId]: { type: "idle" },
          },
        })
      }
    }

    const result = await sdk().session.unrevert({ sessionID: sessionId, directory: sessionDirectory })
    if (result.error) {
      const msg = (result.error as { message?: string })?.message || "Unrevert error"
      throw new Error(`Unrevert failed: ${msg}`)
    }
    if (!result.data) {
      throw new Error(`Missing unrevert response data for session ${sessionId}`)
    }
    if (result.data.id !== sessionId) {
      throw new Error(`Unrevert session ID mismatch: expected ${sessionId}, got ${result.data.id}`)
    }

    reconcileRevertedSession(sessionDirectory, result.data)
  } finally {
    unlockRevertSessions([sessionId])
  }
}

/**
 * Fork from a user message.
 *
 * 1. Extract text from the message for input restoration
 * 2. Call SDK session.fork()
 * 3. Insert the new session into the child store (so sidebar updates immediately)
 * 4. Switch to new session and set pending input text
 */
export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const store = dirStore()
  const state = store.getState()

  // Extract message text for input restoration (only non-synthetic text parts —
  // the server adds file content as synthetic text parts that should not be restored)
  const parts = state.part[messageId] ?? []
  let messageText = ""
  const textParts = parts.filter((p) => p.type === "text" && !isSyntheticPart(p))
  messageText = textParts
    .map((p: Part) => ((p as Record<string, unknown>).text as string) || ((p as Record<string, unknown>).content as string) || "")
    .join("\n")
    .trim()

  const result = await sdk().session.fork({ sessionID: sessionId, directory: dir(), messageID: messageId })
  if (!result.data) return

  const forkedSession = result.data

  // Insert new session into child store so sidebar updates immediately
  const current = store.getState()
  const sessions = [...current.session]
  const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, forkedSession)
    store.setState({ session: sessions })
  }

  // Switch to new session
  useSessionUIStore.getState().setCurrentSession(forkedSession.id)

  // Restore forked message text to input
  if (messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }
}
