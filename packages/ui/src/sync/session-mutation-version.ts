/**
 * Session mutation version registry.
 * Tracks target-specific mutation generation numbers to prevent stale GET reconciliation
 * from resurrecting sessions deleted or updated concurrently (e.g. via SSE).
 */

const _versions = new Map<string, number>()
const _tombstones = new Set<string>()

export function getSessionMutationVersion(sessionId: string): number {
  return _versions.get(sessionId) ?? 0
}

export function bumpSessionMutationVersion(sessionId: string): number {
  const next = (_versions.get(sessionId) ?? 0) + 1
  _versions.set(sessionId, next)
  return next
}

export function markSessionDeleted(sessionId: string): void {
  _tombstones.add(sessionId)
  bumpSessionMutationVersion(sessionId)
}

export function isSessionMarkedDeleted(sessionId: string): boolean {
  return _tombstones.has(sessionId)
}

export function clearSessionDeleted(sessionId: string): void {
  _tombstones.delete(sessionId)
}

export function clearSessionMutationVersions(): void {
  _versions.clear()
  _tombstones.clear()
}
