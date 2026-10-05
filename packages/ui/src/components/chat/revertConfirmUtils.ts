import { revertToMessage } from '@/sync/session-actions';

export interface RevertConfirmTarget {
    sessionId: string;
    messageId: string;
}

export interface RevertExecutionResult {
    executed: boolean;
    success: boolean;
    error: string | null;
    target: RevertConfirmTarget | null;
}

export interface ExecuteRevertConfirmOptions {
    target: RevertConfirmTarget | null;
    isPendingRef: { current: boolean };
    isMounted: () => boolean;
    setIsPending?: (pending: boolean) => void;
    setError?: (error: string | null) => void;
    onConfirm?: (() => Promise<void> | void) | null;
    getLatestOnSuccess?: () => (((target?: RevertConfirmTarget) => void) | undefined);
    getLatestOnOpenChange?: () => (((open: boolean) => void) | undefined);
    performRevert?: (sessionId: string, messageId: string) => Promise<unknown>;
    notifyError?: (errorDetail: string) => void;
}

export async function executeRevertConfirm({
    target,
    isPendingRef,
    isMounted,
    setIsPending,
    setError,
    onConfirm,
    getLatestOnSuccess,
    getLatestOnOpenChange,
    performRevert = revertToMessage,
    notifyError,
}: ExecuteRevertConfirmOptions): Promise<RevertExecutionResult> {
    // Synchronous ref guard prevents multiple invocations
    if (isPendingRef.current) {
        return { executed: false, success: false, error: null, target: null };
    }
    if (!target?.sessionId || !target?.messageId) {
        return { executed: false, success: false, error: null, target: null };
    }

    isPendingRef.current = true;
    setIsPending?.(true);
    setError?.(null);

    // Capture stable target to avoid reading mutable references
    const stableTarget: RevertConfirmTarget = {
        sessionId: target.sessionId,
        messageId: target.messageId,
    };

    try {
        if (onConfirm) {
            await onConfirm();
        } else {
            await performRevert(stableTarget.sessionId, stableTarget.messageId);
        }

        if (isMounted()) {
            getLatestOnSuccess?.()?.(stableTarget);
            getLatestOnOpenChange?.()?.(false);
        }

        return { executed: true, success: true, error: null, target: stableTarget };
    } catch (err: unknown) {
        const errorDetail = err instanceof Error ? err.message : String(err);
        if (isMounted()) {
            setError?.(errorDetail);
        }
        notifyError?.(errorDetail);
        // Keep dialog open on error so user can inspect details
        return { executed: true, success: false, error: errorDetail, target: stableTarget };
    } finally {
        isPendingRef.current = false;
        if (isMounted()) {
            setIsPending?.(false);
        }
    }
}

export interface HandleTimelineRevertSuccessOptions {
    isMounted: boolean | (() => boolean);
    currentSessionId: string | null;
    targetSessionId?: string | null;
    onCloseTimeline: () => void;
    onResetTarget: () => void;
}

export function handleTimelineRevertSuccess({
    isMounted,
    currentSessionId,
    targetSessionId,
    onCloseTimeline,
    onResetTarget,
}: HandleTimelineRevertSuccessOptions): boolean {
    const mounted = typeof isMounted === 'function' ? isMounted() : isMounted;
    let closed = false;

    if (mounted && targetSessionId && currentSessionId === targetSessionId) {
        onCloseTimeline();
        closed = true;
    }

    onResetTarget();
    return closed;
}
