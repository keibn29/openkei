import { describe, expect, test, beforeEach, afterEach, spyOn, mock } from "bun:test"
import type { OpencodeClient, Session, Message, Event } from "@opencode-ai/sdk/v2/client"
import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useSessionUIStore } from "./session-ui-store"
import { applyDirectoryEvent } from "./event-reducer"
import { clearSessionMutationVersions } from "./session-mutation-version"

const deleteCalls: Array<{ sessionID: string; directory?: string }> = []
const getCalls: Array<{ sessionID: string; directory?: string }> = []
let deleteResolvers: Array<() => void> = []
let getResolvers: Array<() => void> = []
let shouldDeferDelete = false
let shouldDeferGet = false
let failOnSessionId: string | null = null
let customDeleteError: Record<string, unknown> | null = null
let customGetError: Record<string, unknown> | null = null
let notFoundOnGetSessionIds = new Set<string>()
const customGetResponseBySessionId = new Map<string, Session>()
let currentDirectoryMock = "/project/a"
let consoleErrorSpy: ReturnType<typeof spyOn> | null = null
const originalLoadSessions = useGlobalSessionsStore.getState().loadSessions

const mockSdk = {
  session: {
    delete: mock(async (params: { sessionID: string; directory?: string }) => {
      deleteCalls.push(params)
      if (shouldDeferDelete) {
        await new Promise<void>((resolve) => {
          deleteResolvers.push(resolve)
        })
      }
      if (customDeleteError) {
        throw customDeleteError
      }
      if (failOnSessionId === params.sessionID) {
        throw new Error(`Server error deleting ${params.sessionID}`)
      }
      return { data: true }
    }),
    get: mock(async (params: { sessionID: string; directory?: string }) => {
      getCalls.push(params)
      if (shouldDeferGet) {
        await new Promise<void>((resolve) => {
          getResolvers.push(resolve)
        })
      }
      if (customGetError) {
        throw customGetError
      }
      if (notFoundOnGetSessionIds.has(params.sessionID)) {
        return { error: { status: 404, message: "Session not found" }, response: { status: 404 } }
      }
      if (customGetResponseBySessionId.has(params.sessionID)) {
        return { data: customGetResponseBySessionId.get(params.sessionID)! }
      }
      return {
        data: {
          id: params.sessionID,
          directory: params.directory,
          time: { updated: 100 },
        } as Session,
      }
    }),
  },
}

function createTestStore(initial?: Partial<DirectoryStore>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createTestChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
  } as unknown as import("./child-store").ChildStoreManager
}

describe("findDescendantSessionIds", () => {
  test("collects multi-level hierarchy in children-first post-order and ignores other trees", async () => {
    const { findDescendantSessionIds } = await import("./session-actions")

    const sessions: Session[] = [
      { id: "root-1" } as Session,
      { id: "child-1", parentID: "root-1" } as Session,
      { id: "grandchild-1", parentID: "child-1" } as Session,
      { id: "child-2", parentID: "root-1" } as Session,
      // Unrelated main session tree
      { id: "root-2" } as Session,
      { id: "child-unrelated", parentID: "root-2" } as Session,
      // Unrelated standalone session with similar timestamp
      { id: "root-3", time: { created: 1000 } } as Session,
    ]

    const descendants = findDescendantSessionIds(["root-1"], sessions)
    // grandchild-1 should be visited before child-1
    expect(descendants).toEqual(["grandchild-1", "child-1", "child-2"])
    // Must NOT contain any session from root-2 or root-3
    expect(descendants.includes("root-2")).toBe(false)
    expect(descendants.includes("child-unrelated")).toBe(false)
    expect(descendants.includes("root-3")).toBe(false)
  })

  test("handles empty descendants and cycles safely without including roots as children", async () => {
    const { findDescendantSessionIds } = await import("./session-actions")

    const sessions: Session[] = [
      { id: "root-alone" } as Session,
      { id: "cyc-1", parentID: "cyc-2" } as Session,
      { id: "cyc-2", parentID: "cyc-1" } as Session,
    ]

    expect(findDescendantSessionIds(["root-alone"], sessions)).toEqual([])
    // Cycle doesn't hang or crash and does not return the root as a descendant
    const cycleDescendants = findDescendantSessionIds(["cyc-1"], sessions)
    expect(cycleDescendants).toEqual(["cyc-2"])
  })
})

describe("deleteSessions directory capture, atomic removal, cascade, and totals", () => {
  let projectStore: StoreApi<DirectoryStore>
  let unrelatedStore: StoreApi<DirectoryStore>
  let childStores: import("./child-store").ChildStoreManager

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})
    useGlobalSessionsStore.setState({
      loadSessions: mock(async () => ({ activeSessions: [], archivedSessions: [] })),
    })
    deleteCalls.length = 0
    getCalls.length = 0
    deleteResolvers = []
    getResolvers = []
    shouldDeferDelete = false
    shouldDeferGet = false
    failOnSessionId = null
    customDeleteError = null
    customGetError = null
    notFoundOnGetSessionIds = new Set()
    customGetResponseBySessionId.clear()
    currentDirectoryMock = "/project/a"

    // Setup child store sessions
    projectStore = createTestStore({
      session: [
        { id: "child-a", parentID: "parent-root", directory: "/project/a" } as Session,
        { id: "grandchild-a", parentID: "child-a", directory: "/project/a" } as Session,
        { id: "parent-root", directory: "/project/a" } as Session,
      ],
      sessionTotal: 1,
      message: {
        "parent-root": [{ id: "m1", sessionID: "parent-root" } as unknown as Message],
        "child-a": [{ id: "m2", sessionID: "child-a" } as unknown as Message],
      },
    })

    unrelatedStore = createTestStore({
      session: [
        { id: "unrelated-root", directory: "/project/b" } as Session,
      ],
      sessionTotal: 1,
    })

    childStores = createTestChildStores([
      ["/project/a", projectStore],
      ["/project/b", unrelatedStore],
    ])

    // Setup global sessions store
    useGlobalSessionsStore.getState().applySnapshot(
      [
        { id: "child-a", parentID: "parent-root", directory: "/project/a" } as Session,
        { id: "grandchild-a", parentID: "child-a", directory: "/project/a" } as Session,
        { id: "parent-root", directory: "/project/a" } as Session,
        { id: "unrelated-root", directory: "/project/b" } as Session,
      ],
      [],
    )
  })

  afterEach(() => {
    if (consoleErrorSpy) {
      consoleErrorSpy.mockRestore()
      consoleErrorSpy = null
    }
    useGlobalSessionsStore.setState({
      loadSessions: originalLoadSessions,
    })
    clearSessionMutationVersions()
    useGlobalSessionsStore.getState().applySnapshot([], [])
    useSessionUIStore.getState().setCurrentSession(null)
  })

  test("Item 1: captures authoritative directory in preflight; current directory switch does not leak into SDK delete", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    // Initially current directory is /project/b while target sessions are in /project/a
    currentDirectoryMock = "/project/b"
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentDirectoryMock)

    // Add a global-only session in /project/a (not in child store) as descendant of grandchild-a
    useGlobalSessionsStore.getState().upsertSession({
      id: "global-leaf",
      parentID: "grandchild-a",
      directory: "/project/a",
    } as Session)

    shouldDeferDelete = true
    const deletePromise = deleteSessions(["parent-root"])

    // Switch current directory to /project/c while delete is in flight
    currentDirectoryMock = "/project/c"

    // Release deferred deletes
    while (deleteResolvers.length > 0) {
      const resolve = deleteResolvers.shift()!
      resolve()
      await new Promise((r) => setTimeout(r, 0))
    }

    const result = await deletePromise
    expect(result.failedIds).toEqual([])
    expect(result.deletedIds).toContain("parent-root")
    expect(result.deletedIds).toContain("global-leaf")

    // Every single SDK delete MUST use /project/a (never /project/b and never /project/c)
    expect(deleteCalls.length).toBe(4)
    for (const call of deleteCalls) {
      expect(call.directory).toBe("/project/a")
    }
  })

  test("Item 1: fails closed before optimistic removal if target directory cannot be resolved", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "")

    // A session whose directory cannot be resolved anywhere
    const result = await deleteSessions(["orphan-no-dir"])

    expect(result.deletedIds).toEqual([])
    expect(result.failedIds).toEqual(["orphan-no-dir"])
    // SDK delete was never called
    expect(deleteCalls.length).toBe(0)
  })

  test("Item 2: child delete failure then root success confirms cascade delete; never resurrects child", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // In children-first order: grandchild-a, child-a, parent-root
    // Fail child-a during its individual delete call
    failOnSessionId = "child-a"

    const result = await deleteSessions(["parent-root"])

    // Even though child-a failed individually, parent-root succeeded and cascaded child-a!
    // Both are confirmed deleted!
    expect(result.deletedIds).toContain("parent-root")
    expect(result.deletedIds).toContain("child-a")
    expect(result.failedIds).toEqual([])

    // child-a must NOT be resurrected in global store or child store
    const globalActive = useGlobalSessionsStore.getState().activeSessions
    expect(globalActive.some((s) => s.id === "child-a")).toBe(false)
    expect(globalActive.some((s) => s.id === "parent-root")).toBe(false)

    const projectSessions = projectStore.getState().session
    expect(projectSessions.some((s) => s.id === "child-a")).toBe(false)
    expect(projectSessions.some((s) => s.id === "parent-root")).toBe(false)
  })

  test("Item 2A: deferred GET, emit reducer session.deleted before resolve stale GET => no restore", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // Fail parent-root delete so it falls back to GET reconciliation
    failOnSessionId = "parent-root"
    shouldDeferGet = true

    const deletePromise = deleteSessions(["parent-root"])

    // Wait until session.get is called and deferred
    await new Promise((r) => setTimeout(r, 10))
    expect(getCalls.length).toBe(1)
    expect(getCalls[0].sessionID).toBe("parent-root")

    // While GET is pending in flight, an SSE event session.deleted arrives for parent-root!
    const draft = { ...projectStore.getState() }
    applyDirectoryEvent(draft, {
      type: "session.deleted",
      properties: { info: { id: "parent-root" } },
    } as unknown as Event)
    projectStore.setState(draft)

    // Now resolve the stale GET (which returns an old record)
    while (getResolvers.length > 0) {
      const resolve = getResolvers.shift()!
      resolve()
      await new Promise((r) => setTimeout(r, 0))
    }

    const result = await deletePromise
    expect(result.failedIds).toContain("parent-root")

    // The stale GET must NOT restore parent-root to either global store or child store
    const globalActive = useGlobalSessionsStore.getState().activeSessions
    expect(globalActive.some((s) => s.id === "parent-root")).toBe(false)

    const projectSessions = projectStore.getState().session
    expect(projectSessions.some((s) => s.id === "parent-root")).toBe(false)
  })

  test("Item 2B: deferred GET, emit reducer session.updated with newer record before resolve stale GET => neither global nor child overwritten", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    failOnSessionId = "parent-root"
    shouldDeferGet = true

    const deletePromise = deleteSessions(["parent-root"])

    await new Promise((r) => setTimeout(r, 10))
    expect(getCalls.length).toBe(1)

    // While GET is pending, an SSE event session.updated arrives with a newer record (time.updated = 999)
    const newerParent: Session = {
      id: "parent-root",
      directory: "/project/a",
      title: "Newer from SSE",
      time: { updated: 999 },
    } as Session

    const draft = { ...projectStore.getState() }
    applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: { info: newerParent },
    } as unknown as Event)
    projectStore.setState(draft)
    useGlobalSessionsStore.getState().upsertSession(newerParent)

    // Now resolve the stale GET (which returns an old record with time.updated = 100)
    while (getResolvers.length > 0) {
      const resolve = getResolvers.shift()!
      resolve()
      await new Promise((r) => setTimeout(r, 0))
    }

    await deletePromise

    // Neither child store nor global store should be overwritten by the stale record!
    const projectSessions = projectStore.getState().session
    const inChild = projectSessions.find((s) => s.id === "parent-root")
    expect(inChild?.title).toBe("Newer from SSE")
    expect(inChild?.time?.updated).toBe(999)

    const globalActive = useGlobalSessionsStore.getState().activeSessions
    const inGlobal = globalActive.find((s) => s.id === "parent-root")
    expect(inGlobal?.title).toBe("Newer from SSE")
    expect(inGlobal?.time?.updated).toBe(999)
  })

  test("Item 2C: non-404 error (status 500/403 with message 'not found') remains failed/uncertain with no false success", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // Delete fails with status 500 and message 'session not found'
    customDeleteError = {
      status: 500,
      statusCode: 500,
      message: "Server internal error: session not found",
    }
    // GET also fails with status 500
    customGetError = {
      status: 500,
      statusCode: 500,
      message: "Server internal error: session not found",
    }

    const result = await deleteSessions(["parent-root"])

    // Must NOT be treated as 404 / deleted; must remain failed!
    expect(result.deletedIds).toEqual([])
    expect(result.failedIds).toContain("parent-root")
  })

  test("Item 2D: actual HTTP status 404 on delete is idempotently confirmed deleted", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // Delete fails with actual 404 response
    customDeleteError = {
      status: 404,
      response: { status: 404 },
      message: "Not found",
    }

    const result = await deleteSessions(["parent-root"])

    // Actual 404 confirmed deleted idempotently!
    expect(result.deletedIds).toContain("parent-root")
    expect(result.failedIds).toEqual([])
  })

  test("Item 2E: failed delete, GET returns original timestamp, session restored in BOTH global and child store; no duplicate/sorted damage", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // Setup sessions in child store and global store with exact timestamp
    const originalTime = { created: 1000, updated: 1000 }
    const rootSession: Session = {
      id: "parent-root",
      directory: "/project/a",
      title: "Root Session",
      time: originalTime,
    } as Session
    const otherSession: Session = {
      id: "a-other",
      directory: "/project/a",
      title: "Other Session",
      time: originalTime,
    } as Session
    const zSession: Session = {
      id: "z-other",
      directory: "/project/a",
      title: "Z Session",
      time: originalTime,
    } as Session

    projectStore.setState({
      session: [otherSession, rootSession, zSession],
      sessionTotal: 3,
    })
    useGlobalSessionsStore.getState().applySnapshot([otherSession, rootSession, zSession], [])

    // Deletion fails on server for parent-root
    failOnSessionId = "parent-root"
    customGetResponseBySessionId.set("parent-root", rootSession)

    // GET returns parent-root with the EXACT same original timestamp
    const result = await deleteSessions(["parent-root"])

    expect(result.failedIds).toContain("parent-root")

    // 1. Session IS restored in global store
    const globalActive = useGlobalSessionsStore.getState().activeSessions
    const globalRestored = globalActive.find((s) => s.id === "parent-root")
    expect(globalRestored !== undefined).toBe(true)
    expect(globalRestored?.title).toBe("Root Session")
    expect(globalActive.filter((s) => s.id === "parent-root").length).toBe(1)

    // 2. Session IS restored in child store
    const childSessions = projectStore.getState().session
    const childRestored = childSessions.find((s) => s.id === "parent-root")
    expect(childRestored !== undefined).toBe(true)
    expect(childRestored?.title).toBe("Root Session")

    // 3. No duplicate damage
    expect(childSessions.filter((s) => s.id === "parent-root").length).toBe(1)

    // 4. Sorted order preserved (a-other < parent-root < z-other)
    expect(childSessions.map((s) => s.id)).toEqual(["a-other", "parent-root", "z-other"])
  })

  test("Item 3: sessionTotal is NOT mutated during optimistic removal, preventing double decrement with SSE", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // Setup 2 roots in projectStore: root-1 and root-2
    const root1: Session = { id: "root-1", directory: "/project/a" } as Session
    const root2: Session = { id: "root-2", directory: "/project/a" } as Session

    projectStore.setState({
      session: [root1, root2],
      sessionTotal: 2,
    })
    useGlobalSessionsStore.getState().applySnapshot([root1, root2], [])

    // Defer network delete so we inspect optimistic state
    shouldDeferDelete = true
    const deletePromise = deleteSessions(["root-1"])

    // 1. Optimistic removal removes root-1 from UI session list array immediately
    const immediateSessions = projectStore.getState().session
    expect(immediateSessions.map((s) => s.id)).toEqual(["root-2"])

    // 2. But sessionTotal is UNCHANGED (still 2) to leave authoritative total to SSE
    expect(projectStore.getState().sessionTotal).toBe(2)

    // Complete the server delete
    while (deleteResolvers.length > 0) {
      const resolve = deleteResolvers.shift()!
      resolve()
      await new Promise((r) => setTimeout(r, 0))
    }
    await deletePromise

    // 3. Now simulate authoritative session.deleted event arriving from SSE for root-1
    const draft = { ...projectStore.getState() }
    applyDirectoryEvent(draft, {
      type: "session.deleted",
      properties: { info: root1 },
    } as unknown as Event)
    projectStore.setState(draft)

    // 4. sessionTotal is decremented once by the reducer: from 2 to exactly 1!
    expect(projectStore.getState().sessionTotal).toBe(1)
  })

  test("Item 4: deduplicates incoming IDs and expanded descendants", async () => {
    const { setActionRefs, deleteSessions } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/project/a")

    // Pass duplicate IDs: both parent and child repeatedly
    const result = await deleteSessions(["parent-root", "child-a", "parent-root", "child-a"])

    expect(result.failedIds).toEqual([])
    // Each ID should only be deleted once on the SDK
    const calledIds = deleteCalls.map((c) => c.sessionID)
    const uniqueCalledIds = Array.from(new Set(calledIds))
    expect(calledIds.length).toBe(uniqueCalledIds.length)
  })
})
