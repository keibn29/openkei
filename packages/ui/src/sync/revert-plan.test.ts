import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Session, Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  validateRootTargetMessage,
  assertNoConcurrentMessagesAfterNow,
  findCascadeTargetMessage,
  discoverTransitiveChildren,
  fetchAllSessionMessages,
  buildRevertPlan,
  isValidTimestamp,
} from "./revert-plan"
import { computeSlashUndoTarget, computeSlashRedoAction } from "./session-ui-store"

describe("revert-plan: timestamp validation and cutoff", () => {
  test("isValidTimestamp validates positive finite numbers", () => {
    expect(isValidTimestamp(12345)).toBe(true)
    expect(isValidTimestamp(Date.now())).toBe(true)
    expect(isValidTimestamp(0)).toBe(false)
    expect(isValidTimestamp(-100)).toBe(false)
    expect(isValidTimestamp(NaN)).toBe(false)
    expect(isValidTimestamp(Infinity)).toBe(false)
    expect(isValidTimestamp("12345")).toBe(false)
    expect(isValidTimestamp(null)).toBe(false)
    expect(isValidTimestamp(undefined)).toBe(false)
  })

  test("validateRootTargetMessage extracts cutoff from valid user message", () => {
    const msg: Message = {
      id: "msg-root-u2",
      sessionID: "s-root",
      role: "user",
      time: { created: 1000 },
    } as Message

    const cutoff = validateRootTargetMessage(msg, "s-root", "msg-root-u2", 2000)
    expect(cutoff).toBe(1000)
  })

  test("validateRootTargetMessage rejects missing target message", () => {
    expect(() => validateRootTargetMessage(undefined, "s-root", "msg-missing", 2000)).toThrow(
      "Target message msg-missing not found in session s-root"
    )
  })

  test("validateRootTargetMessage rejects non-user message", () => {
    const assistantMsg: Message = {
      id: "msg-assistant",
      sessionID: "s-root",
      role: "assistant",
      time: { created: 1000 },
    } as Message

    expect(() => validateRootTargetMessage(assistantMsg, "s-root", "msg-assistant", 2000)).toThrow(
      "is not a user message"
    )
  })

  test("validateRootTargetMessage rejects invalid or NaN timestamp", () => {
    const invalidMsg: Message = {
      id: "msg-bad-time",
      sessionID: "s-root",
      role: "user",
      time: { created: NaN },
    } as unknown as Message

    expect(() => validateRootTargetMessage(invalidMsg, "s-root", "msg-bad-time", 2000)).toThrow(
      "invalid or non-numeric created timestamp"
    )
  })

  test("validateRootTargetMessage rejects timestamp after capturedNow", () => {
    const futureMsg: Message = {
      id: "msg-future",
      sessionID: "s-root",
      role: "user",
      time: { created: 2500 },
    } as Message

    expect(() => validateRootTargetMessage(futureMsg, "s-root", "msg-future", 2000)).toThrow(
      "timestamp (2500) is after captured time (2000)"
    )
  })
})

describe("revert-plan: concurrent message upper bound check", () => {
  test("assertNoConcurrentMessagesAfterNow passes when all messages within bound", () => {
    const msgs: Message[] = [
      { id: "m1", time: { created: 500 } } as Message,
      { id: "m2", time: { created: 1000 } } as Message,
    ]
    let threw = false
    try {
      assertNoConcurrentMessagesAfterNow(msgs, "s1", 1000)
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })

  test("assertNoConcurrentMessagesAfterNow throws when a message exceeds upper bound", () => {
    const msgs: Message[] = [
      { id: "m1", time: { created: 500 } } as Message,
      { id: "m2", time: { created: 1500 } } as Message,
    ]
    expect(() => assertNoConcurrentMessagesAfterNow(msgs, "s1", 1000)).toThrow(
      "Concurrent message m2 in session s1 was created at 1500, after captured time 1000"
    )
  })
})

describe("revert-plan: findCascadeTargetMessage", () => {
  const cutoff = 1000
  const now = 2000

  test("childA u1 only skipped completely (u1.time.created < cutoff)", () => {
    const messages: Message[] = [
      { id: "childA-u1", role: "user", time: { created: 500 } } as Message,
      { id: "childA-a1", role: "assistant", time: { created: 600 } } as Message,
    ]
    const target = findCascadeTargetMessage(messages, cutoff, now, "childA")
    expect(target).toBeNull()
  })

  test("childB u2 later reverted to right user", () => {
    const messages: Message[] = [
      { id: "childB-u1", role: "user", time: { created: 500 } } as Message,
      { id: "childB-a1", role: "assistant", time: { created: 600 } } as Message,
      { id: "childB-u2", role: "user", time: { created: 1200 } } as Message,
      { id: "childB-a2", role: "assistant", time: { created: 1300 } } as Message,
    ]
    const target = findCascadeTargetMessage(messages, cutoff, now, "childB")
    expect(target !== null).toBe(true)
    expect(target?.id).toBe("childB-u2")
  })

  test("reused child prefix: c1 < cutoff retained, c2 >= cutoff chosen", () => {
    const messages: Message[] = [
      { id: "c1", role: "user", time: { created: 800 } } as Message,
      { id: "a1", role: "assistant", time: { created: 850 } } as Message,
      { id: "c2", role: "user", time: { created: 1100 } } as Message,
      { id: "a2", role: "assistant", time: { created: 1200 } } as Message,
      { id: "c3", role: "user", time: { created: 1400 } } as Message,
    ]
    const target = findCascadeTargetMessage(messages, cutoff, now, "reused-child")
    // Reverts from first user message in [cutoff, now] -> c2! Prefix c1 is preserved.
    expect(target !== null).toBe(true)
    expect(target?.id).toBe("c2")
  })

  test("older child assistant completing late but old user -> no revert to old first user", () => {
    const messages: Message[] = [
      { id: "old-u1", role: "user", time: { created: 400 } } as Message,
      // Assistant started early, completed after cutoff
      {
        id: "old-a1",
        role: "assistant",
        time: { created: 450, completed: 1500 },
      } as unknown as Message,
    ]
    const target = findCascadeTargetMessage(messages, cutoff, now, "late-assistant-child")
    // Must NOT revert to old-u1! Child must be untouched.
    expect(target).toBeNull()
  })

  test("invalid timestamp throws explicit error", () => {
    const messages: Message[] = [
      { id: "bad-msg", role: "user", time: { created: -1 } } as Message,
    ]
    expect(() => findCascadeTargetMessage(messages, cutoff, now, "bad-child")).toThrow(
      "invalid created timestamp"
    )
  })
})

describe("revert-plan: discoverTransitiveChildren", () => {
  test("grandchild loaded via SDK not in cache is included", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "root") {
            return {
              data: [
                { id: "child-1", directory: "/dir1", parentID: "root" } as Session,
              ],
            }
          }
          if (params.sessionID === "child-1") {
            // Grandchild discovered via SDK
            return {
              data: [
                { id: "grandchild-1", directory: "/dir2", parentID: "child-1" } as Session,
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const discovered = await discoverTransitiveChildren(mockSdk, "root", "/root-dir")
    expect(discovered.length).toBe(2)
    expect(discovered.map((d) => d.id)).toEqual(["child-1", "grandchild-1"])
    expect(discovered.find((d) => d.id === "grandchild-1")?.depth).toBe(2)
  })

  test("handles cycles in session hierarchy safely", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "root") {
            return {
              data: [{ id: "cycle-child", directory: "/dir", parentID: "root" } as Session],
            }
          }
          if (params.sessionID === "cycle-child") {
            // Cycle: points back to root!
            return {
              data: [{ id: "root", directory: "/dir", parentID: "cycle-child" } as Session],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const discovered = await discoverTransitiveChildren(mockSdk, "root", "/dir")
    expect(discovered.length).toBe(1)
    expect(discovered[0].id).toBe("cycle-child")
  })

  test("throws on SDK children read failure", async () => {
    const mockSdk = {
      session: {
        children: async () => ({
          error: { message: "Network error" },
        }),
      },
    } as unknown as OpencodeClient

    let caught: Error | null = null
    try {
      await discoverTransitiveChildren(mockSdk, "root", "/dir")
    } catch (err) {
      caught = err as Error
    }
    expect(caught !== null).toBe(true)
    expect(caught?.message).toContain(
      "Failed to discover children for session root: Network error"
    )
  })

  test("two main sessions A/B: only A descendants discovered, B sessions never included even in local cache", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "session-a") {
            return {
              data: [
                { id: "a-child", directory: "/test/dir", parentID: "session-a" } as Session,
              ],
            }
          }
          if (params.sessionID === "a-child") {
            return {
              data: [
                { id: "a-grandchild", directory: "/test/dir", parentID: "a-child" } as Session,
              ],
            }
          }
          if (params.sessionID === "session-b") {
            return {
              data: [
                { id: "b-child", directory: "/test/dir", parentID: "session-b" } as Session,
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const localCacheSessions: Session[] = [
      { id: "session-a", directory: "/test/dir" } as Session,
      { id: "a-child", directory: "/test/dir", parentID: "session-a" } as Session,
      { id: "a-grandchild", directory: "/test/dir", parentID: "a-child" } as Session,
      { id: "session-b", directory: "/test/dir" } as Session,
      { id: "b-child", directory: "/test/dir", parentID: "session-b" } as Session,
      { id: "b-grandchild", directory: "/test/dir", parentID: "b-child" } as Session,
    ]

    const discovered = await discoverTransitiveChildren(
      mockSdk,
      "session-a",
      "/test/dir",
      localCacheSessions,
    )

    expect(discovered.map((d) => d.id)).toEqual(["a-child", "a-grandchild"])
    expect(discovered.map((d) => d.parentID)).toEqual(["session-a", "a-child"])
    expect(discovered.some((d) => d.id.startsWith("b-") || d.id === "session-b")).toBe(false)
  })

  test("rejects malformed SDK child with mismatched parentID to fail closed", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "session-a") {
            // Malformed: SDK returns a session belonging to session-b!
            return {
              data: [
                { id: "b-child", directory: "/test/dir", parentID: "session-b" } as Session,
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    let caught: Error | null = null
    try {
      await discoverTransitiveChildren(mockSdk, "session-a", "/test/dir")
    } catch (err) {
      caught = err as Error
    }

    expect(caught !== null).toBe(true)
    expect(caught?.message).toContain("Malformed session hierarchy: child session b-child parentID 'session-b' does not match expected parent 'session-a'")
  })

  test("rejects malformed SDK child with missing parentID to fail closed", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "session-a") {
            // Malformed: parentID missing
            return {
              data: [
                { id: "orphan-child", directory: "/test/dir" } as Session,
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    let caught: Error | null = null
    try {
      await discoverTransitiveChildren(mockSdk, "session-a", "/test/dir")
    } catch (err) {
      caught = err as Error
    }

    expect(caught !== null).toBe(true)
    expect(caught?.message).toContain("Malformed session hierarchy: child session orphan-child parentID 'undefined' does not match expected parent 'session-a'")
  })

  test("handles self-cycle and root cycle safely without duplicate nodes or infinite loop", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "session-a") {
            return {
              data: [
                // Direct self-cycle: child claims to be session-a
                { id: "session-a", directory: "/test/dir", parentID: "session-a" } as Session,
                // Legitimate child
                { id: "child-1", directory: "/test/dir", parentID: "session-a" } as Session,
              ],
            }
          }
          if (params.sessionID === "child-1") {
            return {
              data: [
                // Self-loop on child-1
                { id: "child-1", directory: "/test/dir", parentID: "child-1" } as Session,
                // Root cycle pointing back to root
                { id: "session-a", directory: "/test/dir", parentID: "child-1" } as Session,
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const discovered = await discoverTransitiveChildren(mockSdk, "session-a", "/test/dir")
    // Only child-1 is discovered once; root and self-cycles are ignored
    expect(discovered.length).toBe(1)
    expect(discovered[0].id).toBe("child-1")
    expect(discovered[0].parentID).toBe("session-a")
  })
})

describe("revert-plan: fetchAllSessionMessages", () => {
  test("paginates messages using x-next-cursor", async () => {
    const recordedCalls: Array<{ sessionID: string; before?: string }> = []
    const mockSdk = {
      session: {
        messages: async (params: { sessionID: string; before?: string }) => {
          recordedCalls.push({ ...params })
          if (recordedCalls.length === 1) {
            return {
              data: [
                {
                  info: { id: "m2", time: { created: 200 } } as Message,
                  parts: [{ id: "p2", type: "text", text: "hello" } as Part],
                },
              ],
              response: {
                headers: {
                  get: (name: string) => (name === "x-next-cursor" ? "cur-1" : null),
                },
              },
            }
          }
          return {
            data: [
              {
                info: { id: "m1", time: { created: 100 } } as Message,
                parts: [{ id: "p1", type: "text", text: "start" } as Part],
              },
            ],
            response: {
              headers: {
                get: () => null,
              },
            },
          }
        },
      },
    } as unknown as OpencodeClient

    const result = await fetchAllSessionMessages(mockSdk, "s1", "/dir")
    expect(result.messages.length).toBe(2)
    expect(recordedCalls.length).toBe(2)
    expect(recordedCalls[0].before).toBe(undefined)
    expect(recordedCalls[1].before).toBe("cur-1")
    // Chronologically sorted: m1 then m2
    expect(result.messages[0].id).toBe("m1")
    expect(result.messages[1].id).toBe("m2")
    expect(result.partsByMessageId.get("m1")?.[0].id).toBe("p1")
  })

  test("throws when nextCursor repeats previous cursor or cycle detected", async () => {
    const mockSdk = {
      session: {
        messages: async () => ({
          data: [{ info: { id: "m1", time: { created: 100 } } as Message }],
          response: {
            headers: {
              get: (name: string) => (name === "x-next-cursor" ? "same-cursor" : null),
            },
          },
        }),
      },
    } as unknown as OpencodeClient

    let caught: Error | null = null
    try {
      await fetchAllSessionMessages(mockSdk, "s1", "/dir")
    } catch (err) {
      caught = err as Error
    }
    expect(caught !== null).toBe(true)
    expect(caught?.message).toContain("Pagination cycle or repeated cursor detected (same-cursor)")
  })

  test("page budget fail closed", async () => {
    let callIdx = 0
    const mockSdk = {
      session: {
        messages: async () => {
          callIdx++
          return {
            data: [{ info: { id: `m-${callIdx}`, time: { created: 100 } } }],
            response: {
              headers: {
                get: (name: string) => (name === "x-next-cursor" ? `cur-${callIdx}` : null),
              },
            },
          }
        },
      },
    } as unknown as OpencodeClient

    let caught: Error | null = null
    try {
      await fetchAllSessionMessages(mockSdk, "s1", "/dir", 3)
    } catch (err) {
      caught = err as Error
    }
    expect(caught !== null).toBe(true)
    expect(caught?.message).toContain("Pagination page budget (3) exceeded")
  })
})

describe("revert-plan: buildRevertPlan", () => {
  test("builds plan with deepest-child first order and skips untouched children", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "root") {
            return {
              data: [
                { id: "childA", directory: "/dirA", parentID: "root" } as Session,
                { id: "childB", directory: "/dirB", parentID: "root" } as Session,
              ],
            }
          }
          if (params.sessionID === "childB") {
            return {
              data: [
                { id: "grandchildB1", directory: "/dirGB", parentID: "childB" } as Session,
              ],
            }
          }
          return { data: [] }
        },
        messages: async (params: { sessionID: string }) => {
          if (params.sessionID === "root") {
            return {
              data: [
                { info: { id: "u1", role: "user", time: { created: 500 } } },
                { info: { id: "u2", role: "user", time: { created: 1000 } } },
              ],
            }
          }
          if (params.sessionID === "childA") {
            // childA only has u1 before cutoff (1000)
            return {
              data: [
                { info: { id: "ca-u1", role: "user", time: { created: 600 } } },
              ],
            }
          }
          if (params.sessionID === "childB") {
            // childB has a user message at cutoff
            return {
              data: [
                { info: { id: "cb-u1", role: "user", time: { created: 600 } } },
                { info: { id: "cb-u2", role: "user", time: { created: 1050 } } },
              ],
            }
          }
          if (params.sessionID === "grandchildB1") {
            // grandchild has a matching user message
            return {
              data: [
                { info: { id: "gb-u1", role: "user", time: { created: 1100 } } },
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const plan = await buildRevertPlan({
      client: mockSdk,
      rootSessionId: "root",
      rootMessageId: "u2",
      rootDirectory: "/root-dir",
      capturedNow: 2000,
    })

    expect(plan.cutoff).toBe(1000)
    // Targets: grandchildB1 (depth 2), childB (depth 1), root (depth 0)
    // childA is completely skipped!
    expect(plan.targets.map((t) => t.sessionID)).toEqual(["grandchildB1", "childB", "root"])
    expect(plan.targets.find((t) => t.sessionID === "grandchildB1")?.messageID).toBe("gb-u1")
    expect(plan.targets.find((t) => t.sessionID === "childB")?.messageID).toBe("cb-u2")
    expect(plan.targets.find((t) => t.sessionID === "root")?.messageID).toBe("u2")
  })

  test("if no matching children, exactly one parent revert", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "root") {
            return {
              data: [{ id: "child1", directory: "/dir", parentID: "root" } as Session],
            }
          }
          return { data: [] }
        },
        messages: async (params: { sessionID: string }) => {
          if (params.sessionID === "root") {
            return {
              data: [{ info: { id: "root-u", role: "user", time: { created: 1000 } } }],
            }
          }
          // child has only old messages
          return {
            data: [{ info: { id: "child-old", role: "user", time: { created: 200 } } }],
          }
        },
      },
    } as unknown as OpencodeClient

    const plan = await buildRevertPlan({
      client: mockSdk,
      rootSessionId: "root",
      rootMessageId: "root-u",
      rootDirectory: "/dir",
      capturedNow: 2000,
    })

    expect(plan.targets.length).toBe(1)
    expect(plan.targets[0].sessionID).toBe("root")
    expect(plan.targets[0].messageID).toBe("root-u")
  })

  test("two main sessions A and B same directory with overlapping timestamps: only A hierarchy planned, B ignored", async () => {
    const mockSdk = {
      session: {
        children: async (params: { sessionID: string }) => {
          if (params.sessionID === "session-a") {
            return {
              data: [
                { id: "a-child", directory: "/same/dir", parentID: "session-a" } as Session,
              ],
            }
          }
          if (params.sessionID === "a-child") {
            return {
              data: [
                { id: "a-grandchild", directory: "/same/dir", parentID: "a-child" } as Session,
              ],
            }
          }
          if (params.sessionID === "session-b") {
            return {
              data: [
                { id: "b-child", directory: "/same/dir", parentID: "session-b" } as Session,
              ],
            }
          }
          if (params.sessionID === "b-child") {
            return {
              data: [
                { id: "b-grandchild", directory: "/same/dir", parentID: "b-child" } as Session,
              ],
            }
          }
          return { data: [] }
        },
        messages: async (params: { sessionID: string }) => {
          // Both session A and B have user messages in the exact same time window
          if (params.sessionID === "session-a") {
            return {
              data: [
                { info: { id: "a-u1", role: "user", time: { created: 1000 } } },
                { info: { id: "a-u2", role: "user", time: { created: 2000 } } },
              ],
            }
          }
          if (params.sessionID === "a-child") {
            return {
              data: [
                { info: { id: "ac-u1", role: "user", time: { created: 2100 } } },
              ],
            }
          }
          if (params.sessionID === "a-grandchild") {
            return {
              data: [
                { info: { id: "ag-u1", role: "user", time: { created: 2200 } } },
              ],
            }
          }
          if (params.sessionID === "session-b") {
            return {
              data: [
                { info: { id: "b-u1", role: "user", time: { created: 1050 } } },
                { info: { id: "b-u2", role: "user", time: { created: 2050 } } },
              ],
            }
          }
          if (params.sessionID === "b-child") {
            return {
              data: [
                { info: { id: "bc-u1", role: "user", time: { created: 2150 } } },
              ],
            }
          }
          return { data: [] }
        },
      },
    } as unknown as OpencodeClient

    const localCacheSessions: Session[] = [
      { id: "session-a", directory: "/same/dir" } as Session,
      { id: "a-child", directory: "/same/dir", parentID: "session-a" } as Session,
      { id: "a-grandchild", directory: "/same/dir", parentID: "a-child" } as Session,
      { id: "session-b", directory: "/same/dir" } as Session,
      { id: "b-child", directory: "/same/dir", parentID: "session-b" } as Session,
      { id: "b-grandchild", directory: "/same/dir", parentID: "b-child" } as Session,
    ]

    const plan = await buildRevertPlan({
      client: mockSdk,
      rootSessionId: "session-a",
      rootMessageId: "a-u2",
      rootDirectory: "/same/dir",
      capturedNow: 3000,
      localDescendants: localCacheSessions,
    })

    expect(plan.cutoff).toBe(2000)
    // Targets must only be A grandchild, A child, and session-a
    expect(plan.targets.map((t) => t.sessionID)).toEqual(["a-grandchild", "a-child", "session-a"])
    expect(plan.targets.some((t) => t.sessionID.startsWith("b-") || t.sessionID === "session-b")).toBe(false)
  })

  test("rejects plan if discoveredChildren contains root session", async () => {
    const mockSdk = {
      session: {
        messages: async () => ({
          data: [{ info: { id: "u1", role: "user", time: { created: 1000 } } }],
        }),
      },
    } as unknown as OpencodeClient

    let caught: Error | null = null
    try {
      await buildRevertPlan({
        client: mockSdk,
        rootSessionId: "root",
        rootMessageId: "u1",
        rootDirectory: "/dir",
        capturedNow: 2000,
        discoveredChildren: [
          { id: "root", directory: "/dir", depth: 1, parentID: "root" },
        ],
      })
    } catch (err) {
      caught = err as Error
    }

    expect(caught !== null).toBe(true)
    expect(caught?.message).toContain("discovered children cannot contain root session root")
  })
})

describe("session-ui-store: slash undo/redo calculation", () => {
  const userMessages = [
    { id: "u0" },
    { id: "u1" },
    { id: "u2" },
  ]

  test("undo when not reverted targets the latest user message", () => {
    const target = computeSlashUndoTarget(userMessages, undefined)
    expect(target?.id).toBe("u2")
  })

  test("undo when reverted at u2 steps backward to u1", () => {
    const target = computeSlashUndoTarget(userMessages, "u2")
    expect(target?.id).toBe("u1")
  })

  test("undo when reverted at u1 steps backward to u0", () => {
    const target = computeSlashUndoTarget(userMessages, "u1")
    expect(target?.id).toBe("u0")
  })

  test("undo when already at earliest user message (u0) returns undefined", () => {
    const target = computeSlashUndoTarget(userMessages, "u0")
    expect(target).toBe(undefined)
  })

  test("undo guard: invalid revertToId not in userMessages does NOT fall back to u0 (-1 + 1 bug)", () => {
    const target = computeSlashUndoTarget(userMessages, "unknown-id")
    expect(target).toBe(undefined)
  })

  test("redo when not reverted returns undefined", () => {
    const action = computeSlashRedoAction(userMessages, undefined)
    expect(action).toBe(undefined)
  })

  test("redo when reverted at u0 steps forward to u1", () => {
    const action = computeSlashRedoAction(userMessages, "u0")
    expect(action).toEqual({ type: "revert", target: { id: "u1" } })
  })

  test("redo when reverted at u1 steps forward to u2", () => {
    const action = computeSlashRedoAction(userMessages, "u1")
    expect(action).toEqual({ type: "revert", target: { id: "u2" } })
  })

  test("redo when reverted at latest message (u2) triggers full unrevert", () => {
    const action = computeSlashRedoAction(userMessages, "u2")
    expect(action).toEqual({ type: "unrevert" })
  })

  test("redo guard: invalid revertToId not in userMessages returns undefined", () => {
    const action = computeSlashRedoAction(userMessages, "unknown-id")
    expect(action).toBe(undefined)
  })
})
