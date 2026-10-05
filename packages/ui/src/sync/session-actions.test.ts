import { describe, expect, test, beforeEach, mock } from "bun:test"
import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"

// Mock SDK client that records permission.reply / question.reply calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []

const mockScopedClient = {
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      return Promise.resolve({ data: true })
    }),
  },
}

const sdkCalls: Array<{ method: string; params: Record<string, unknown> }> = []
let shouldFailRevertOnSessionId: string | null = null
let shouldFailAbortOnSessionId: string | null = null

const mockSdk = {
  permission: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "permission.reply", params })
      return Promise.resolve({ data: true })
    }),
  },
  question: {
    reply: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reply", params })
      return Promise.resolve({ data: true })
    }),
    reject: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "question.reject", params })
      return Promise.resolve({ data: true })
    }),
  },
  session: {
    children: mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.children", params })
      if (params.sessionID === "root-session") {
        return {
          data: [
            { id: "child-preserved", directory: "/test/project", parentID: "root-session" } as Session,
            { id: "child-revert", directory: "/other/project", parentID: "root-session" } as Session,
          ],
        }
      }
      return { data: [] }
    }),
    messages: mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.messages", params })
      if (params.sessionID === "root-session") {
        return {
          data: [
            {
              info: { id: "m-u1", role: "user", time: { created: 1000 } } as Message,
              parts: [{ id: "p-u1", type: "text", text: "first root turn" } as Part],
            },
            {
              info: { id: "m-u2", role: "user", time: { created: 2000 } } as Message,
              parts: [{ id: "p-u2", type: "text", text: "second root turn" } as Part],
            },
          ],
        }
      }
      if (params.sessionID === "child-preserved") {
        return {
          data: [
            {
              info: { id: "cp-u1", role: "user", time: { created: 1200 } } as Message,
              parts: [{ id: "p-cp1", type: "text", text: "old child prompt" } as Part],
            },
          ],
        }
      }
      if (params.sessionID === "child-revert") {
        return {
          data: [
            {
              info: { id: "cr-u1", role: "user", time: { created: 1500 } } as Message,
              parts: [{ id: "p-cr1", type: "text", text: "turn 1 child prompt" } as Part],
            },
            {
              info: { id: "cr-u2", role: "user", time: { created: 2100 } } as Message,
              parts: [{ id: "p-cr2", type: "text", text: "turn 2 child prompt" } as Part],
            },
          ],
        }
      }
      return { data: [] }
    }),
    abort: mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.abort", params })
      if (shouldFailAbortOnSessionId === params.sessionID) {
        return { error: { message: `Abort rejected for ${params.sessionID}` } }
      }
      return { data: true }
    }),
    revert: mock(async (params: { sessionID: string; messageID: string; directory?: string }) => {
      sdkCalls.push({ method: "session.revert", params })
      if (shouldFailRevertOnSessionId === params.sessionID) {
        return { error: { message: `Revert failed on server for ${params.sessionID}` } }
      }
      return {
        data: {
          id: params.sessionID,
          directory: params.directory || "/test/project",
          revert: { messageID: params.messageID },
        } as unknown as Session,
      }
    }),
    unrevert: mock(async (params: { sessionID: string; directory?: string }) => {
      sdkCalls.push({ method: "session.unrevert", params })
      return {
        data: {
          id: params.sessionID,
          directory: params.directory || "/test/project",
          revert: undefined,
        } as unknown as Session,
      }
    }),
  },
}

let currentSessionIdMock: string | null = "root-session"
let currentMockDirectory = "/test/project"
let pendingInputState = { pendingInputText: "", pendingInputMode: "" }
const globalUpsertedSessions: Session[] = []

// Mock opencodeClient singleton
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: () => mockScopedClient,
    getDirectory: () => currentMockDirectory,
  },
}))

let mockConfigState = {
  isConnected: true,
  hasEverConnected: true,
  probeConnection: async () => true,
}

// Mock useConfigStore
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => mockConfigState,
  },
}))

// Mock useSessionUIStore
mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: currentSessionIdMock,
      getDirectoryForSession: (sessionId: string) => {
        if (sessionId === "session-a") return "/test/project"
        if (sessionId === "session-b") return "/other/project"
        if (sessionId === "root-session") return "/test/project"
        if (sessionId === "child-revert") return "/other/project"
        if (sessionId === "child-preserved") return "/test/project"
        return null
      },
    }),
  },
}))

// Mock useInputStore
mock.module("./input-store", () => ({
  useInputStore: {
    setState: (update: typeof pendingInputState) => {
      Object.assign(pendingInputState, update)
    },
    getState: () => pendingInputState,
  },
}))

// Mock useGlobalSessionsStore
mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: (s: Session) => {
        globalUpsertedSessions.push(s)
      },
    }),
  },
}))

// Mock sync-refs (imported but not used in permission functions)
mock.module("./sync-refs", () => ({
  registerSessionDirectory: () => {},
  getSyncChildStores: () => ({ children: new Map() }),
  getAllSyncSessions: () => [],
  getDirectoryState: () => undefined,
  getSyncDirectory: () => "/test/project",
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getSyncSessionStatus: () => undefined,
  getSyncPermissions: () => [],
  getSyncQuestions: () => [],
  getSyncSDK: () => mockSdk,
  setSyncRefs: () => {},
}))

import { create, type StoreApi } from "zustand"
import { INITIAL_STATE } from "./types"
import type { DirectoryStore } from "./child-store"

function createStore(permissions: Record<string, PermissionRequest[]>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    permission: permissions,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
  } as unknown as import("./child-store").ChildStoreManager
}

describe("respondToPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory from child store when permission is found", async () => {
    const permission: PermissionRequest = {
      id: "perm-1",
      sessionID: "session-a",
      permission: "bash",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-a", "perm-1", "once")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-1")
    expect(replyCalls[0].params.reply).toBe("once")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })

  test("passes directory from session mapping when permission not in store", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToPermission("session-b", "perm-2", "always")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-2")
    expect(replyCalls[0].params.reply).toBe("always")
    expect(replyCalls[0].params.directory).toBe("/other/project")
  })

  test("passes directory from current directory as last resort", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/fallback/dir")

    await respondToPermission("unknown-session", "perm-3", "reject")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-3")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/fallback/dir")
  })
})

describe("dismissPermission passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory and reply=reject", async () => {
    const permission: PermissionRequest = {
      id: "perm-10",
      sessionID: "session-a",
      permission: "edit",
      patterns: [],
      metadata: {},
      always: [],
    }

    const store = createStore({ "session-a": [permission] })
    const childStores = createChildStores([["/test/project", store]])

    const { setActionRefs, dismissPermission } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await dismissPermission("session-a", "perm-10")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("perm-10")
    expect(replyCalls[0].params.reply).toBe("reject")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("respondToQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory to question.reply", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, respondToQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await respondToQuestion("session-a", "q-1", [["answer1"]])

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-1")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("rejectQuestion passes directory", () => {
  beforeEach(() => {
    replyCalls.length = 0
  })

  test("passes directory to question.reject", async () => {
    const childStores = createChildStores([])

    const { setActionRefs, rejectQuestion } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await rejectQuestion("session-a", "q-2")

    expect(replyCalls.length).toBe(1)
    expect(replyCalls[0].params.requestID).toBe("q-2")
    expect(replyCalls[0].params.directory).toBe("/test/project")
  })
})

describe("session-actions: revertToMessage cascading execution", () => {
  let rootStore: StoreApi<DirectoryStore>
  let childStore: StoreApi<DirectoryStore>
  let childStores: import("./child-store").ChildStoreManager

  beforeEach(() => {
    sdkCalls.length = 0
    globalUpsertedSessions.length = 0
    shouldFailRevertOnSessionId = null
    shouldFailAbortOnSessionId = null
    currentMockDirectory = "/test/project"
    currentSessionIdMock = "root-session"
    pendingInputState = { pendingInputText: "", pendingInputMode: "" }
    mockConfigState = {
      isConnected: true,
      hasEverConnected: true,
      probeConnection: async () => true,
    }

    rootStore = createStore({})
    rootStore.setState({
      session: [
        { id: "root-session", directory: "/test/project" } as Session,
        { id: "child-preserved", directory: "/test/project", parentID: "root-session" } as Session,
      ],
    })
    childStore = createStore({})
    childStore.setState({
      session: [
        { id: "child-revert", directory: "/other/project", parentID: "root-session" } as Session,
      ],
    })

    childStores = createChildStores([
      ["/test/project", rootStore],
      ["/other/project", childStore],
    ])
  })

  test("actual action calls exactly intended IDs in deepest-first order", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    await revertToMessage("root-session", "m-u2")

    // Check calls: deepest child child-revert first, then root-session
    const revertCalls = sdkCalls.filter((c) => c.method === "session.revert")
    expect(revertCalls.length).toBe(2)
    expect(revertCalls[0].params.sessionID).toBe("child-revert")
    expect(revertCalls[0].params.messageID).toBe("cr-u2")
    expect(revertCalls[0].params.directory).toBe("/other/project")

    expect(revertCalls[1].params.sessionID).toBe("root-session")
    expect(revertCalls[1].params.messageID).toBe("m-u2")
    expect(revertCalls[1].params.directory).toBe("/test/project")

    // Preserved child was untouched (no revert call)
    expect(revertCalls.some((c) => c.params.sessionID === "child-preserved")).toBe(false)

    // Store was updated with returned marker without deleting messages
    const rootState = rootStore.getState()
    const childState = childStore.getState()
    expect(rootState.session.find((s) => s.id === "root-session")?.revert?.messageID).toBe("m-u2")
    expect(childState.session.find((s) => s.id === "child-revert")?.revert?.messageID).toBe("cr-u2")

    // Input prompt restored with root target text
    expect(pendingInputState.pendingInputText).toBe("second root turn")
    expect(pendingInputState.pendingInputMode).toBe("replace")
  })

  test("directory change during pending does not alter captured scope", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // Simulate directory switch midway through operation
    const revertPromise = revertToMessage("root-session", "m-u2")
    currentMockDirectory = "/some/unrelated/directory"

    await revertPromise

    // The captured directory was preserved, no leak to /some/unrelated/directory
    const rootRevertCall = sdkCalls.find(
      (c) => c.method === "session.revert" && c.params.sessionID === "root-session"
    )
    expect(rootRevertCall?.params.directory).toBe("/test/project")
  })

  test("aborts busy planned session, but never preserved-only child", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // Mark planned child-revert as busy
    childStore.setState({
      session_status: {
        "child-revert": { type: "busy" },
      },
    })
    // Mark preserved child as busy
    rootStore.setState({
      session_status: {
        "child-preserved": { type: "busy" },
      },
    })

    await revertToMessage("root-session", "m-u2")

    const abortCalls = sdkCalls.filter((c) => c.method === "session.abort")
    // Only child-revert should be aborted! Never preserved-only child!
    expect(abortCalls.some((c) => c.params.sessionID === "child-revert")).toBe(true)
    expect(abortCalls.some((c) => c.params.sessionID === "child-preserved")).toBe(false)
  })

  test("partial failure surfaces successfully reverted session IDs without sensitive content", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // Fail revert on root session (which executes second after child-revert)
    shouldFailRevertOnSessionId = "root-session"

    let caughtError: Error | null = null
    try {
      await revertToMessage("root-session", "m-u2")
    } catch (err) {
      caughtError = err as Error
    }

    expect(caughtError !== null).toBe(true)
    expect(caughtError!.message).toContain(
      "Partial revert failure: successfully reverted sessions [child-revert]"
    )
    expect(caughtError!.message).toContain("root-session")

    // No input prompt change on error!
    expect(pendingInputState.pendingInputText).toBe("")
  })

  test("duplicate conflicting operation is blocked while in flight", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // First operation is running
    const firstOp = revertToMessage("root-session", "m-u2")
    // Second concurrent operation on root-session
    let caught: Error | null = null
    try {
      await revertToMessage("root-session", "m-u2")
    } catch (err) {
      caught = err as Error
    }
    expect(caught !== null).toBe(true)
    expect(caught!.message).toContain(
      "Conflicting revert/unrevert operation already in progress"
    )

    await firstOp
  })

  test("pause A discovery, attempt B root unrevert -> reject B", async () => {
    const { setActionRefs, revertToMessage, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    let resolveDiscovery: () => void = () => {}
    const discoveryPromise = new Promise<void>((resolve) => {
      resolveDiscovery = resolve
    })

    // Intercept session.children for root-session to pause discovery
    const origChildren = mockSdk.session.children
    mockSdk.session.children = mock(async (params: { sessionID: string }) => {
      if (params.sessionID === "root-session") {
        await discoveryPromise
      }
      return origChildren(params)
    })

    try {
      // Start operation A (revertToMessage)
      const opA = revertToMessage("root-session", "m-u2")

      // Attempt B: root unrevert while A is paused in discovery
      let caughtB: Error | null = null
      try {
        await unrevertSession("root-session")
      } catch (err) {
        caughtB = err as Error
      }

      // Root was reserved BEFORE first await, so B is rejected immediately!
      expect(caughtB !== null).toBe(true)
      expect(caughtB!.message).toContain("Conflicting revert/unrevert operation already in progress")

      // Allow A to finish
      resolveDiscovery()
      await opA
    } finally {
      mockSdk.session.children = origChildren
    }
  })

  test("descendant finish during planning -> revalidate reject stale not mutate", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // Simulate descendant finishing an operation during planning that changes its revert marker
    let callsCount = 0
    const origChildren = mockSdk.session.children
    mockSdk.session.children = mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.children", params })
      if (params.sessionID === "root-session") {
        callsCount++
        if (callsCount === 1) {
          // Discovery: child has no revert marker
          return {
            data: [
              { id: "child-revert", directory: "/other/project", parentID: "root-session" } as Session,
            ],
          }
        }
        // Topology recheck / revalidation: child finished an operation that changed its revert marker!
        return {
          data: [
            {
              id: "child-revert",
              directory: "/other/project",
              parentID: "root-session",
              revert: { messageID: "other-revert-marker" },
            } as Session,
          ],
        }
      }
      return { data: [] }
    })

    let caught: Error | null = null
    try {
      await revertToMessage("root-session", "m-u2")
    } catch (err) {
      caught = err as Error
    } finally {
      mockSdk.session.children = origChildren
    }

    expect(caught !== null).toBe(true)
    expect(caught!.message).toContain("revert marker changed")

    // Assert NOT mutated: session.revert was never called
    const revertCalls = sdkCalls.filter((c) => c.method === "session.revert")
    expect(revertCalls.length).toBe(0)
  })

  test("controlled injection between child and root rejects affected suffix and reports partial success", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    let childReverted = false
    const origRevert = mockSdk.session.revert
    const origMessages = mockSdk.session.messages

    mockSdk.session.revert = mock(async (params: { sessionID: string; messageID: string; directory?: string }) => {
      if (params.sessionID === "child-revert") {
        childReverted = true
      }
      return origRevert(params)
    })

    mockSdk.session.messages = mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.messages", params })
      if (params.sessionID === "root-session") {
        if (childReverted) {
          // Injected message after capturedNow between child revert and root revert
          return {
            data: [
              { info: { id: "m-u1", role: "user", time: { created: 1000 } } as Message, parts: [] },
              { info: { id: "m-u2", role: "user", time: { created: 2000 } } as Message, parts: [] },
              { info: { id: "m-concurrent", role: "assistant", time: { created: Date.now() + 100_000 } } as Message, parts: [] },
            ],
          }
        }
        return {
          data: [
            { info: { id: "m-u1", role: "user", time: { created: 1000 } } as Message, parts: [] },
            { info: { id: "m-u2", role: "user", time: { created: 2000 } } as Message, parts: [] },
          ],
        }
      }
      if (params.sessionID === "child-revert") {
        return {
          data: [
            { info: { id: "cr-u1", role: "user", time: { created: 1500 } } as Message, parts: [] },
            { info: { id: "cr-u2", role: "user", time: { created: 2100 } } as Message, parts: [] },
          ],
        }
      }
      return { data: [] }
    })

    let caught: Error | null = null
    try {
      await revertToMessage("root-session", "m-u2")
    } catch (err) {
      caught = err as Error
    } finally {
      mockSdk.session.revert = origRevert
      mockSdk.session.messages = origMessages
    }

    expect(caught !== null).toBe(true)
    expect(caught!.message).toContain(
      "Partial revert failure: successfully reverted sessions [child-revert]"
    )
    expect(caught!.message).toContain("Concurrent message m-concurrent in session root-session")

    // child-revert was reverted, root-session was NOT reverted
    const revertCalls = sdkCalls.filter((c) => c.method === "session.revert")
    expect(revertCalls.length).toBe(1)
    expect(revertCalls[0].params.sessionID).toBe("child-revert")
  })

  test("optimisticSend rejects when revert operation is in flight", async () => {
    const { setActionRefs, optimisticSend, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)
    setOptimisticRefs(() => {}, () => {})

    const { lockRevertSessions, unlockRevertSessions } = await import("./revert-plan")
    lockRevertSessions(["root-session"])

    let caught: Error | null = null
    try {
      await optimisticSend({
        sessionId: "root-session",
        content: "test message",
        providerID: "test-provider",
        modelID: "test-model",
        send: async () => {},
      })
    } catch (err) {
      caught = err as Error
    } finally {
      unlockRevertSessions(["root-session"])
    }

    expect(caught !== null).toBe(true)
    expect(caught!.message).toContain("Cannot send message: revert operation in progress for session root-session")
  })

  test("optimisticSend rejects and skips insertion/send when revert lock acquired during deferred connection wait", async () => {
    const { setActionRefs, optimisticSend, setOptimisticRefs } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    let optimisticAdded = false
    let apiSendCalled = false
    setOptimisticRefs(
      () => {
        optimisticAdded = true
      },
      () => {},
    )

    let resolveConnection!: () => void
    let probeStartedResolve!: () => void
    const probeStarted = new Promise<void>((r) => {
      probeStartedResolve = r
    })
    const connectionDeferred = new Promise<void>((r) => {
      resolveConnection = r
    })

    mockConfigState = {
      isConnected: false,
      hasEverConnected: true,
      probeConnection: async () => {
        probeStartedResolve()
        await connectionDeferred
        return true
      },
    }

    const { lockRevertSessions, unlockRevertSessions } = await import("./revert-plan")

    let sendPromise: Promise<void> | null = null
    let caught: Error | null = null

    try {
      sendPromise = optimisticSend({
        sessionId: "root-session",
        content: "test message",
        providerID: "test-provider",
        modelID: "test-model",
        send: async () => {
          apiSendCalled = true
        },
      })

      // Wait until connection probe has started and send is waiting
      await probeStarted

      // Acquire revert lock while connection wait is pending
      lockRevertSessions(["root-session"])

      // Resume connection
      resolveConnection()

      await sendPromise
    } catch (err) {
      caught = err as Error
    } finally {
      unlockRevertSessions(["root-session"])
      mockConfigState = {
        isConnected: true,
        hasEverConnected: true,
        probeConnection: async () => true,
      }
    }

    expect(caught !== null).toBe(true)
    expect(caught!.message).toContain("Cannot send message: revert operation in progress for session root-session")
    expect(optimisticAdded).toBe(false)
    expect(apiSendCalled).toBe(false)
  })

  test("does not restore prompt if current session switched before completion", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // User switches away from root-session while revert is processing
    const revertPromise = revertToMessage("root-session", "m-u2")
    currentSessionIdMock = "some-other-session"

    await revertPromise

    // Prompt was not restored because active session changed
    expect(pendingInputState.pendingInputText).toBe("")
  })

  test("two main sessions A and B same directory and overlapping timestamps: A child and grandchild reverted; B never requested or reverted even in local cache", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    // Setup local cache with sessions from both Main Session A and Main Session B
    const allSessions: Session[] = [
      { id: "session-a", directory: "/test/project" } as Session,
      { id: "a-child", directory: "/test/project", parentID: "session-a" } as Session,
      { id: "a-grandchild", directory: "/test/project", parentID: "a-child" } as Session,
      { id: "session-b", directory: "/test/project" } as Session,
      { id: "b-child", directory: "/test/project", parentID: "session-b" } as Session,
      { id: "b-grandchild", directory: "/test/project", parentID: "b-child" } as Session,
    ]
    rootStore.setState({ session: allSessions })

    const origChildren = mockSdk.session.children
    const origMessages = mockSdk.session.messages
    const origRevert = mockSdk.session.revert

    mockSdk.session.children = mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.children", params })
      if (params.sessionID === "session-a") {
        return {
          data: [{ id: "a-child", directory: "/test/project", parentID: "session-a" } as Session],
        }
      }
      if (params.sessionID === "a-child") {
        return {
          data: [{ id: "a-grandchild", directory: "/test/project", parentID: "a-child" } as Session],
        }
      }
      if (params.sessionID === "session-b") {
        return {
          data: [{ id: "b-child", directory: "/test/project", parentID: "session-b" } as Session],
        }
      }
      return { data: [] }
    })

    mockSdk.session.messages = mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.messages", params })
      if (params.sessionID === "session-a") {
        return {
          data: [
            { info: { id: "a-u1", role: "user", time: { created: 1000 } } as Message, parts: [] },
            { info: { id: "a-u2", role: "user", time: { created: 2000 } } as Message, parts: [] },
          ],
        }
      }
      if (params.sessionID === "a-child") {
        return {
          data: [
            { info: { id: "ac-u1", role: "user", time: { created: 2100 } } as Message, parts: [] },
          ],
        }
      }
      if (params.sessionID === "a-grandchild") {
        return {
          data: [
            { info: { id: "ag-u1", role: "user", time: { created: 2200 } } as Message, parts: [] },
          ],
        }
      }
      if (params.sessionID === "session-b") {
        return {
          data: [
            { info: { id: "b-u1", role: "user", time: { created: 1050 } } as Message, parts: [] },
            { info: { id: "b-u2", role: "user", time: { created: 2050 } } as Message, parts: [] },
          ],
        }
      }
      if (params.sessionID === "b-child") {
        return {
          data: [
            { info: { id: "bc-u1", role: "user", time: { created: 2150 } } as Message, parts: [] },
          ],
        }
      }
      return { data: [] }
    })

    mockSdk.session.revert = mock(async (params: { sessionID: string; messageID: string; directory?: string }) => {
      sdkCalls.push({ method: "session.revert", params })
      return {
        data: {
          id: params.sessionID,
          directory: params.directory || "/test/project",
          revert: { messageID: params.messageID },
        } as Session,
      }
    })

    try {
      await revertToMessage("session-a", "a-u2")

      // Verification: B sessions were NEVER requested or reverted
      const sessionBChildrenCalls = sdkCalls.filter(
        (c) => c.method === "session.children" && (c.params.sessionID === "session-b" || c.params.sessionID === "b-child")
      )
      expect(sessionBChildrenCalls.length).toBe(0)

      const sessionBMessagesCalls = sdkCalls.filter(
        (c) => c.method === "session.messages" && (c.params.sessionID === "session-b" || c.params.sessionID === "b-child")
      )
      expect(sessionBMessagesCalls.length).toBe(0)

      const revertCalls = sdkCalls.filter((c) => c.method === "session.revert")
      expect(revertCalls.length).toBe(3)
      // Sequential deepest-first order: a-grandchild -> a-child -> session-a
      expect(revertCalls[0].params.sessionID).toBe("a-grandchild")
      expect(revertCalls[0].params.messageID).toBe("ag-u1")
      expect(revertCalls[1].params.sessionID).toBe("a-child")
      expect(revertCalls[1].params.messageID).toBe("ac-u1")
      expect(revertCalls[2].params.sessionID).toBe("session-a")
      expect(revertCalls[2].params.messageID).toBe("a-u2")

      const anyBRevert = revertCalls.some((c) => c.params.sessionID === "session-b" || c.params.sessionID === "b-child")
      expect(anyBRevert).toBe(false)
    } finally {
      mockSdk.session.children = origChildren
      mockSdk.session.messages = origMessages
      mockSdk.session.revert = origRevert
    }
  })

  test("malformed SDK returns B child for A -> fails closed, zero destructive mutations, parentID not inferred", async () => {
    const { setActionRefs, revertToMessage } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    const origChildren = mockSdk.session.children
    const origRevert = mockSdk.session.revert
    const origAbort = mockSdk.session.abort

    // Malformed SDK: returns session belonging to main session B when querying children for session A
    mockSdk.session.children = mock(async (params: { sessionID: string }) => {
      sdkCalls.push({ method: "session.children", params })
      if (params.sessionID === "session-a") {
        return {
          data: [
            { id: "b-child", directory: "/test/project", parentID: "session-b" } as Session,
          ],
        }
      }
      return { data: [] }
    })

    let caught: Error | null = null
    try {
      await revertToMessage("session-a", "a-u2")
    } catch (err) {
      caught = err as Error
    } finally {
      mockSdk.session.children = origChildren
      mockSdk.session.revert = origRevert
      mockSdk.session.abort = origAbort
    }

    expect(caught !== null).toBe(true)
    expect(caught!.message).toContain(
      "Malformed session hierarchy: child session b-child parentID 'session-b' does not match expected parent 'session-a'"
    )

    // Assert zero destructive mutations: no reverts, no aborts
    const revertCalls = sdkCalls.filter((c) => c.method === "session.revert")
    expect(revertCalls.length).toBe(0)
    const abortCalls = sdkCalls.filter((c) => c.method === "session.abort")
    expect(abortCalls.length).toBe(0)

    // Assert locks were cleanly released (fail closed, not left hanging)
    const { isRevertInflight } = await import("./revert-plan")
    expect(isRevertInflight("session-a")).toBe(false)
    expect(isRevertInflight("b-child")).toBe(false)
  })
})

describe("session-actions: unrevertSession hardening", () => {
  let rootStore: StoreApi<DirectoryStore>
  let childStores: import("./child-store").ChildStoreManager

  beforeEach(() => {
    sdkCalls.length = 0
    currentMockDirectory = "/test/project"

    rootStore = createStore({})
    rootStore.setState({
      session: [
        {
          id: "root-session",
          directory: "/test/project",
          revert: { messageID: "m-u2" },
        } as unknown as Session,
      ],
    })

    childStores = createChildStores([["/test/project", rootStore]])
  })

  test("unrevert clears revert marker and calls SDK with resolved directory", async () => {
    const { setActionRefs, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    await unrevertSession("root-session")

    const unrevertCalls = sdkCalls.filter((c) => c.method === "session.unrevert")
    expect(unrevertCalls.length).toBe(1)
    expect(unrevertCalls[0].params.sessionID).toBe("root-session")
    expect(unrevertCalls[0].params.directory).toBe("/test/project")

    const sessionInStore = rootStore.getState().session.find((s) => s.id === "root-session")
    expect(sessionInStore?.revert).toBe(undefined)
  })

  test("aborts busy session before unreverting", async () => {
    const { setActionRefs, unrevertSession } = await import("./session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => currentMockDirectory)

    rootStore.setState({
      session_status: {
        "root-session": { type: "busy" },
      },
    })

    await unrevertSession("root-session")

    const abortCalls = sdkCalls.filter((c) => c.method === "session.abort")
    expect(abortCalls.length).toBe(1)
    expect(abortCalls[0].params.sessionID).toBe("root-session")
  })
})
