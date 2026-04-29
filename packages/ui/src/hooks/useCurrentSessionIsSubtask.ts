import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';

export type CurrentSessionSubtaskState = {
  isSubtask: boolean;
  parentSessionId: string | null;
  parentDirectory: string | null;
  parentTitle: string | null;
};

export function useCurrentSessionSubtaskState(): CurrentSessionSubtaskState {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const subtaskNavigationHint = useSessionUIStore(
    React.useCallback((state) => {
      if (!currentSessionId) {
        return null;
      }

      const hint = state.subtaskNavigationHint;
      return hint?.sessionId === currentSessionId ? hint : null;
    }, [currentSessionId]),
  );

  const currentSession = useSession(currentSessionId);
  const liveParentSessionId = typeof currentSession?.parentID === 'string' && currentSession.parentID.trim().length > 0
    ? currentSession.parentID
    : null;
  const parentSessionId = liveParentSessionId ?? subtaskNavigationHint?.parentSessionId ?? null;
  const parentSession = useSession(parentSessionId);

  return React.useMemo(() => {
    const parentDirectory = (parentSession as Session & { directory?: string | null } | undefined)?.directory
      ?? subtaskNavigationHint?.parentDirectory
      ?? null;
    const parentTitle = parentSession?.title?.trim() || null;

    return {
      isSubtask: Boolean(parentSessionId),
      parentSessionId,
      parentDirectory,
      parentTitle,
    };
  }, [parentSession, parentSessionId, subtaskNavigationHint]);
}

export function useCurrentSessionIsSubtask(): boolean {
  return useCurrentSessionSubtaskState().isSubtask;
}
