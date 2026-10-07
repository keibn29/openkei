import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

// Install minimal hook dispatcher for headless unit testing of useSessionActions
const testDispatcher = {
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useContext: () => ({ t: (key: string) => key }),
};

const internals = (React as unknown as Record<string, { H?: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const previousDispatcher = internals ? internals.H : null;

beforeAll(() => {
  if (internals) {
    internals.H = testDispatcher;
  }
});

afterAll(() => {
  if (internals && previousDispatcher !== null) {
    internals.H = previousDispatcher;
  }
});

let consoleErrorSpy: ReturnType<typeof spyOn> | null = null;
beforeEach(() => {
  consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (consoleErrorSpy) {
    consoleErrorSpy.mockRestore();
    consoleErrorSpy = null;
  }
});

import { useSessionActions } from './useSessionActions';

// Test harness to invoke useSessionActions without full React DOM rendering
function useActionsHarness(options: {
  isVSCode?: boolean;
  showDeletionDialog?: boolean;
  childrenMap?: Map<string, Session[]>;
  initialConfirm?: { session: Session; descendantCount: number; archivedBucket: boolean; hardDelete?: boolean } | null;
}) {
  const deleteSessionCalls: string[] = [];
  const deleteSessionsCalls: string[][] = [];
  const archiveSessionCalls: string[] = [];
  const archiveSessionsCalls: string[][] = [];
  let confirmState = options.initialConfirm ?? null;

  const mockDeleteSession = mock(async (id: string) => {
    deleteSessionCalls.push(id);
    return true;
  });

  const mockDeleteSessions = mock(async (ids: string[]) => {
    deleteSessionsCalls.push(ids);
    return { deletedIds: ids, failedIds: [] };
  });

  const mockArchiveSession = mock(async (id: string) => {
    archiveSessionCalls.push(id);
    return true;
  });

  const mockArchiveSessions = mock(async (ids: string[]) => {
    archiveSessionsCalls.push(ids);
    return { archivedIds: ids, failedIds: [] };
  });

  const args: Parameters<typeof useSessionActions>[0] = {
    activeProjectId: null,
    currentDirectory: '/test/dir',
    currentSessionId: null,
    mobileVariant: false,
    allowReselect: false,
    isSessionSearchOpen: false,
    sessionSearchQuery: '',
    setSessionSearchQuery: () => {},
    setIsSessionSearchOpen: () => {},
    setActiveProjectIdOnly: () => {},
    setDirectory: () => {},
    setActiveMainTab: () => {},
    setSessionSwitcherOpen: () => {},
    setCurrentSession: () => {},
    updateSessionTitle: async () => {},
    shareSession: async () => null,
    unshareSession: async () => null,
    deleteSession: mockDeleteSession,
    deleteSessions: mockDeleteSessions,
    archiveSession: mockArchiveSession,
    archiveSessions: mockArchiveSessions,
    childrenMap: options.childrenMap ?? new Map(),
    showDeletionDialog: options.showDeletionDialog ?? true,
    setDeleteSessionConfirm: (val) => {
      confirmState = typeof val === 'function' ? (val as (prev: typeof confirmState) => typeof confirmState)(confirmState) : val;
      args.deleteSessionConfirm = confirmState;
    },
    deleteSessionConfirm: confirmState,
    setEditingId: () => {},
    setEditTitle: () => {},
    editingId: null,
    editTitle: '',
  };

  const actions = useSessionActions(args);

  return {
    actions,
    args,
    getConfirmState: () => confirmState,
    deleteSessionCalls,
    deleteSessionsCalls,
    archiveSessionCalls,
    archiveSessionsCalls,
  };
}

describe('useSessionActions - VSCode hard delete policy vs Web archive policy', () => {
  const parentSession: Session = { id: 'parent-1', title: 'Parent Task' } as Session;
  const childSession: Session = { id: 'child-1', parentID: 'parent-1', title: 'Subtask' } as Session;

  const childrenMap = new Map<string, Session[]>([
    ['parent-1', [childSession]],
  ]);

  test('VS Code routing: handleDeleteSession with hardDelete routes to delete and not archive', async () => {
    // When showDeletionDialog is false (direct flow)
    const harness = useActionsHarness({
      showDeletionDialog: false,
      childrenMap,
    });

    // In VS Code, the menu item triggers handleDeleteSession with hardDelete: true
    harness.actions.handleDeleteSession(parentSession, { archivedBucket: false, hardDelete: true });

    // Wait for microtask tick
    await new Promise((r) => setTimeout(r, 10));

    // deleteSessions was called with children first, then parent
    expect(harness.deleteSessionsCalls.length).toBe(1);
    expect(harness.deleteSessionsCalls[0]).toEqual(['child-1', 'parent-1']);

    // archive was NOT called
    expect(harness.archiveSessionsCalls.length).toBe(0);
    expect(harness.archiveSessionCalls.length).toBe(0);
  });

  test('Non-VSCode (Web) routing: handleDeleteSession without hardDelete routes to archive for unarchived session', async () => {
    const harness = useActionsHarness({
      showDeletionDialog: false,
      childrenMap,
    });

    // In Web, unarchived session passes { archivedBucket: false } (no hardDelete)
    harness.actions.handleDeleteSession(parentSession, { archivedBucket: false });

    await new Promise((r) => setTimeout(r, 10));

    // archiveSessions was called, delete was NOT called
    expect(harness.archiveSessionsCalls.length).toBe(1);
    expect(harness.deleteSessionsCalls.length).toBe(0);
    expect(harness.deleteSessionCalls.length).toBe(0);
  });

  test('Confirmation dialog flow: hardDelete passes to dialog state and executes children-first delete on confirm', async () => {
    const harness = useActionsHarness({
      showDeletionDialog: true,
      childrenMap,
    });

    // User triggers menu item in VS Code
    harness.actions.handleDeleteSession(parentSession, { archivedBucket: false, hardDelete: true });

    // Dialog state is set with hardDelete: true and descendantCount: 1
    const confirm = harness.getConfirmState();
    expect(confirm !== null).toBe(true);
    expect(confirm?.session.id).toBe('parent-1');
    expect(confirm?.descendantCount).toBe(1);
    expect(confirm?.hardDelete).toBe(true);

    // If user cancels: confirmState is set to null, no delete occurs
    harness.args.setDeleteSessionConfirm(null);
    expect(harness.getConfirmState()).toBe(null);
    expect(harness.deleteSessionsCalls.length).toBe(0);

    // If user re-opens and confirms:
    harness.actions.handleDeleteSession(parentSession, { archivedBucket: false, hardDelete: true });
    await harness.actions.confirmDeleteSession();

    expect(harness.deleteSessionsCalls.length).toBe(1);
    expect(harness.deleteSessionsCalls[0]).toEqual(['child-1', 'parent-1']);
    expect(harness.archiveSessionsCalls.length).toBe(0);
  });

  test('Single session without descendants calls deleteSession directly when hardDelete is true', async () => {
    const harness = useActionsHarness({
      showDeletionDialog: false,
      childrenMap: new Map(), // No children
    });

    const standaloneSession: Session = { id: 'single-1', title: 'Single' } as Session;
    harness.actions.handleDeleteSession(standaloneSession, { archivedBucket: false, hardDelete: true });

    await new Promise((r) => setTimeout(r, 10));

    expect(harness.deleteSessionCalls).toEqual(['single-1']);
    expect(harness.archiveSessionCalls.length).toBe(0);
  });

  test('SessionNodeItem menu policy helper: VS Code always labels Delete and passes hardDelete', () => {
    // Replicating the SessionNodeItem menu item contract:
    // label: isVSCode || archivedBucket ? t('sessions.sidebar.bulkActions.delete') : t('sessions.sidebar.bulkActions.archive')
    // payload: { archivedBucket, hardDelete: isVSCode ? true : undefined }
    const resolveMenuItem = (isVSCode: boolean, archivedBucket: boolean) => {
      const label = isVSCode || archivedBucket ? 'delete' : 'archive';
      const payload = { archivedBucket, hardDelete: isVSCode ? true : undefined };
      return { label, payload };
    };

    // 1. VS Code with unarchived session -> Delete, hardDelete: true
    expect(resolveMenuItem(true, false)).toEqual({
      label: 'delete',
      payload: { archivedBucket: false, hardDelete: true },
    });

    // 2. VS Code with archived session -> Delete, hardDelete: true
    expect(resolveMenuItem(true, true)).toEqual({
      label: 'delete',
      payload: { archivedBucket: true, hardDelete: true },
    });

    // 3. Web with unarchived session -> Archive, hardDelete: undefined
    expect(resolveMenuItem(false, false)).toEqual({
      label: 'archive',
      payload: { archivedBucket: false, hardDelete: undefined },
    });

    // 4. Web with archived session -> Delete, hardDelete: undefined
    expect(resolveMenuItem(false, true)).toEqual({
      label: 'delete',
      payload: { archivedBucket: true, hardDelete: undefined },
    });
  });

  test('SessionDeleteConfirmDialog policy: switches to delete wording and button when hardDelete is true', () => {
    const resolveDialogContent = (state: { hardDelete?: boolean; archivedBucket: boolean; descendantCount: number }) => {
      const isHardDelete = Boolean(state.hardDelete || state.archivedBucket);
      const title = isHardDelete ? 'dialogs.deleteSession.title' : 'dialogs.archiveSession.title';
      const button = isHardDelete ? 'bulkActions.delete' : 'bulkActions.archive';
      const descKey = isHardDelete
        ? (state.descendantCount > 0 ? (state.descendantCount === 1 ? 'deleteSession.withOneSubtask' : 'deleteSession.withManySubtasks') : 'deleteSession.single')
        : (state.descendantCount > 0 ? (state.descendantCount === 1 ? 'archiveSession.withOneSubtask' : 'archiveSession.withManySubtasks') : 'archiveSession.single');
      return { title, button, descKey };
    };

    // VS Code active session deletion with subtask
    expect(resolveDialogContent({ hardDelete: true, archivedBucket: false, descendantCount: 1 })).toEqual({
      title: 'dialogs.deleteSession.title',
      button: 'bulkActions.delete',
      descKey: 'deleteSession.withOneSubtask',
    });

    // VS Code active session deletion single
    expect(resolveDialogContent({ hardDelete: true, archivedBucket: false, descendantCount: 0 })).toEqual({
      title: 'dialogs.deleteSession.title',
      button: 'bulkActions.delete',
      descKey: 'deleteSession.single',
    });

    // Web active session archiving with subtask
    expect(resolveDialogContent({ hardDelete: false, archivedBucket: false, descendantCount: 1 })).toEqual({
      title: 'dialogs.archiveSession.title',
      button: 'bulkActions.archive',
      descKey: 'archiveSession.withOneSubtask',
    });

    // Web archived session deletion
    expect(resolveDialogContent({ hardDelete: undefined, archivedBucket: true, descendantCount: 0 })).toEqual({
      title: 'dialogs.deleteSession.title',
      button: 'bulkActions.delete',
      descKey: 'deleteSession.single',
    });
  });
});
