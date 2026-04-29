import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';

export function useCurrentSessionIsSubtask(): boolean {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const isSubtaskInCurrentDirectory = useDirectorySync(
    React.useCallback((state) => {
      if (!currentSessionId) return false;
      const session = state.session.find((entry) => entry.id === currentSessionId);
      return Boolean((session as Session | undefined)?.parentID);
    }, [currentSessionId]),
    currentDirectory ?? undefined,
  );

  return React.useMemo(() => {
    if (isSubtaskInCurrentDirectory) {
      return true;
    }

    if (!currentSessionId) {
      return false;
    }

    const fallbackSession = getAllSyncSessions().find((entry) => entry.id === currentSessionId);
    return Boolean((fallbackSession as Session | undefined)?.parentID);
  }, [currentSessionId, isSubtaskInCurrentDirectory]);
}
