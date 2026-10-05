/**
 * Revert plan — pure planning and validation helpers for timestamp-based cascading session reverts.
 *
 * Implements the user-confirmed cascade policy:
 * - Root target message time.created is the cutoff.
 * - Upper bound capturedNow is recorded at entry before any async work.
 * - Authoritative transitive children are discovered via SDK session.children.
 * - Each descendant session is reverted only from its FIRST user message where
 *   cutoff <= time.created <= capturedNow.
 * - If a child has no matching user message in that window, it is left completely untouched (no fallback!).
 * - Suffix revert guarantee: any message in a reverted session created after capturedNow
 *   fails closed to prevent silent data loss from concurrent writes.
 * - Deepest children are executed first sequentially, with the root session last.
 *
 * NOTE: Timestamp matching does NOT guarantee concurrent ownership or filesystem overlap.
 */

import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"

export interface RevertTarget {
  sessionID: string
  directory: string | undefined
  messageID: string
  depth: number
}

export interface RevertPlan {
  cutoff: number
  capturedNow: number
  targets: RevertTarget[]
  rootTargetMessage: Message
  rootTargetParts: Part[]
}

export interface DiscoveredSession {
  id: string
  directory: string | undefined
  depth: number
  parentID: string
  revert?: { messageID?: string }
}

export interface FetchMessagesResult {
  messages: Message[]
  partsByMessageId: Map<string, Part[]>
}

// In-flight locking map to prevent conflicting concurrent revert/unrevert operations
const inflightSessions = new Set<string>()

export function isRevertInflight(sessionId: string): boolean {
  return inflightSessions.has(sessionId)
}

export function lockRevertSessions(sessionIds: string[]): void {
  for (const id of sessionIds) {
    if (inflightSessions.has(id)) {
      throw new Error(`Conflicting revert/unrevert operation already in progress for session ${id}`)
    }
  }
  for (const id of sessionIds) {
    inflightSessions.add(id)
  }
}

export function unlockRevertSessions(sessionIds: string[]): void {
  for (const id of sessionIds) {
    inflightSessions.delete(id)
  }
}

/** Check if timestamp is a valid positive finite number */
export function isValidTimestamp(ts: unknown): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && !Number.isNaN(ts) && ts > 0
}

/** Validate root target message and extract cutoff */
export function validateRootTargetMessage(
  targetMsg: Message | undefined,
  sessionId: string,
  messageId: string,
  capturedNow: number,
): number {
  if (!targetMsg) {
    throw new Error(`Target message ${messageId} not found in session ${sessionId}`)
  }
  if (targetMsg.role !== "user") {
    throw new Error(`Target message ${messageId} is not a user message (role: ${targetMsg.role})`)
  }
  const created = targetMsg.time?.created
  if (!isValidTimestamp(created)) {
    throw new Error(`Target message ${messageId} has invalid or non-numeric created timestamp: ${created}`)
  }
  if (created > capturedNow) {
    throw new Error(`Target message ${messageId} timestamp (${created}) is after captured time (${capturedNow})`)
  }
  return created
}

/**
 * Asserts no concurrent messages exist after capturedNow in a session being reverted.
 * Since the API reverts the entire message suffix starting from messageID, any concurrent message
 * created after the user confirmed cannot be isolated and would be destroyed.
 */
export function assertNoConcurrentMessagesAfterNow(
  messages: Message[],
  sessionId: string,
  capturedNow: number,
): void {
  for (const m of messages) {
    const created = m.time?.created
    if (typeof created === "number" && created > capturedNow) {
      throw new Error(
        `Concurrent message ${m.id} in session ${sessionId} was created at ${created}, after captured time ${capturedNow}`
      )
    }
  }
}

/**
 * Find the cascade target message for a child session.
 * Reverts only from the FIRST user message chronologically where cutoff <= time.created <= capturedNow.
 * Preserves prefix from turn 1.
 * Never falls back to child first message.
 * Returns null if no matching user message exists.
 */
export function findCascadeTargetMessage(
  messages: Message[],
  cutoff: number,
  capturedNow: number,
  sessionId: string,
): Message | null {
  const userMessages = messages.filter((m) => m.role === "user")
  const matching: Message[] = []

  for (const m of userMessages) {
    const created = m.time?.created
    if (!isValidTimestamp(created)) {
      throw new Error(`Message ${m.id} in child session ${sessionId} has invalid created timestamp: ${created}`)
    }
    if (created >= cutoff && created <= capturedNow) {
      matching.push(m)
    }
  }

  if (matching.length === 0) {
    return null
  }

  // Sort chronologically ascending by time.created, then id for deterministic tie-break
  matching.sort((a, b) => {
    const timeA = a.time?.created ?? 0
    const timeB = b.time?.created ?? 0
    if (timeA !== timeB) return timeA - timeB
    return a.id.localeCompare(b.id)
  })

  return matching[0]
}

/**
 * Fetch all messages for a session with pagination budget and error handling.
 */
export async function fetchAllSessionMessages(
  client: OpencodeClient,
  sessionId: string,
  directory: string | undefined,
  maxPages = 50,
): Promise<FetchMessagesResult> {
  const messages: Message[] = []
  const seenIds = new Set<string>()
  const partsByMessageId = new Map<string, Part[]>()
  const visitedCursors = new Set<string>()
  let cursor: string | undefined = undefined
  let pageCount = 0

  while (true) {
    pageCount++
    if (pageCount > maxPages) {
      throw new Error(
        `Pagination page budget (${maxPages}) exceeded while fetching messages for session ${sessionId}`
      )
    }

    const params: { sessionID: string; limit: number; directory?: string; before?: string } = {
      sessionID: sessionId,
      limit: 100,
    }
    if (directory) {
      params.directory = directory
    }
    if (cursor) {
      params.before = cursor
    }

    let res: {
      data?: Array<{ info?: Message; parts?: Part[] }>
      error?: unknown
      response?: { headers?: { get?: (name: string) => string | null } }
    }
    try {
      res = await client.session.messages(params)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to fetch messages for session ${sessionId}: ${msg}`)
    }

    if (res.error) {
      const msg = (res.error as { message?: string })?.message || "SDK read error"
      throw new Error(`Failed to read messages for session ${sessionId}: ${msg}`)
    }

    const items = res.data ?? []
    for (const item of items) {
      const info = (item as { info?: Message }).info ?? (item as unknown as Message)
      if (info && info.id && !seenIds.has(info.id)) {
        seenIds.add(info.id)
        messages.push(info)
        const parts = (item as { parts?: Part[] }).parts ?? []
        partsByMessageId.set(info.id, parts)
      }
    }

    const nextCursor = res.response?.headers?.get?.("x-next-cursor")
    if (!nextCursor) {
      break
    }
    if (nextCursor === cursor || visitedCursors.has(nextCursor)) {
      throw new Error(
        `Pagination cycle or repeated cursor detected (${nextCursor}) while fetching messages for session ${sessionId}`
      )
    }
    visitedCursors.add(nextCursor)
    cursor = nextCursor
  }

  // Sort messages chronologically
  messages.sort((a, b) => {
    const timeA = typeof a.time?.created === "number" ? a.time.created : 0
    const timeB = typeof b.time?.created === "number" ? b.time.created : 0
    if (timeA !== timeB) return timeA - timeB
    return a.id.localeCompare(b.id)
  })

  return { messages, partsByMessageId }
}

/**
 * Authoritative recursive child discovery via SDK session.children.
 * Safeguards against cycles and deduplicates transitive children.
 */
export async function discoverTransitiveChildren(
  client: OpencodeClient,
  rootSessionId: string,
  rootDirectory: string | undefined,
  localDescendants?: Session[],
): Promise<DiscoveredSession[]> {
  const discovered: DiscoveredSession[] = []
  const visited = new Set<string>([rootSessionId])
  const queue: Array<{ sessionID: string; directory: string | undefined; depth: number }> = [
    { sessionID: rootSessionId, directory: rootDirectory, depth: 0 },
  ]

  while (queue.length > 0) {
    const current = queue.shift()!
    let children: Session[] = []

    try {
      const res = await client.session.children({
        sessionID: current.sessionID,
        directory: current.directory,
      })
      if (res.error) {
        const msg = (res.error as { message?: string })?.message || "SDK children error"
        throw new Error(`Failed to discover children for session ${current.sessionID}: ${msg}`)
      }
      children = res.data ?? []
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to discover children for session ${current.sessionID}: ${msg}`)
    }

    // Merge with any local cache sessions matching parentID that were not returned
    if (localDescendants) {
      const localMatches = localDescendants.filter(
        (s) => (s as Session & { parentID?: string }).parentID === current.sessionID
      )
      for (const localChild of localMatches) {
        if (!children.some((c) => c.id === localChild.id)) {
          children.push(localChild)
        }
      }
    }

    for (const child of children) {
      if (!child || !child.id) continue

      // Explicit parentID guard: reject mismatched parent to fail closed before any mutation
      if (child.parentID !== current.sessionID) {
        throw new Error(
          `Malformed session hierarchy: child session ${child.id} parentID '${child.parentID}' does not match expected parent '${current.sessionID}'`
        )
      }

      // Cycle and deduplication guard
      if (visited.has(child.id)) {
        continue
      }
      visited.add(child.id)

      const childDir = child.directory || current.directory
      const node: DiscoveredSession = {
        id: child.id,
        directory: childDir,
        depth: current.depth + 1,
        parentID: child.parentID,
        revert: child.revert ? { messageID: child.revert.messageID } : undefined,
      }
      discovered.push(node)
      queue.push({ sessionID: child.id, directory: childDir, depth: current.depth + 1 })
    }
  }

  return discovered
}

/**
 * Builds the complete revert execution plan.
 * Deepest child first, shallower children next, root session last.
 */
export async function buildRevertPlan(params: {
  client: OpencodeClient
  rootSessionId: string
  rootMessageId: string
  rootDirectory: string | undefined
  capturedNow: number
  localDescendants?: Session[]
  maxPages?: number
  discoveredChildren?: DiscoveredSession[]
}): Promise<RevertPlan> {
  const {
    client,
    rootSessionId,
    rootMessageId,
    rootDirectory,
    capturedNow,
    localDescendants,
    maxPages = 50,
    discoveredChildren,
  } = params

  // 1. Fetch root session messages
  const rootResult = await fetchAllSessionMessages(client, rootSessionId, rootDirectory, maxPages)
  const rootMessages = rootResult.messages
  const targetMsg = rootMessages.find((m) => m.id === rootMessageId)

  // 2. Validate root target message and extract cutoff
  const cutoff = validateRootTargetMessage(targetMsg, rootSessionId, rootMessageId, capturedNow)

  // 3. Suffix revert check: assert no concurrent writes in root session after capturedNow
  assertNoConcurrentMessagesAfterNow(rootMessages, rootSessionId, capturedNow)

  // 4. Discover all transitive children (use provided discoveredChildren if available)
  const children =
    discoveredChildren ??
    (await discoverTransitiveChildren(client, rootSessionId, rootDirectory, localDescendants))

  // Validate discovered children do not contain the root session
  for (const child of children) {
    if (child.id === rootSessionId) {
      throw new Error(`Invalid revert plan: discovered children cannot contain root session ${rootSessionId}`)
    }
  }

  const targets: RevertTarget[] = []

  // 5. For each child, fetch its messages and find first matching user message in window
  for (const child of children) {
    const childResult = await fetchAllSessionMessages(client, child.id, child.directory, maxPages)
    const childTarget = findCascadeTargetMessage(childResult.messages, cutoff, capturedNow, child.id)

    if (childTarget) {
      // Suffix revert check: assert child has no concurrent messages after capturedNow
      assertNoConcurrentMessagesAfterNow(childResult.messages, child.id, capturedNow)

      targets.push({
        sessionID: child.id,
        directory: child.directory,
        messageID: childTarget.id,
        depth: child.depth,
      })
    }
    // If no childTarget: child is untouched! Preserve turn 1, do not revert, do not add to targets.
  }

  // 6. Add root session to targets (depth 0)
  targets.push({
    sessionID: rootSessionId,
    directory: rootDirectory,
    messageID: rootMessageId,
    depth: 0,
  })

  // 7. Sort targets: deepest child first (depth descending), then sessionID ascending
  targets.sort((a, b) => {
    if (a.depth !== b.depth) {
      return b.depth - a.depth // highest depth first
    }
    return a.sessionID.localeCompare(b.sessionID)
  })

  const rootParts = rootResult.partsByMessageId.get(rootMessageId) ?? []

  return {
    cutoff,
    capturedNow,
    targets,
    rootTargetMessage: targetMsg!,
    rootTargetParts: rootParts,
  }
}
