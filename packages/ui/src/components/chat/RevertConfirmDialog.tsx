import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { RiLoader4Line } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';
import { revertToMessage } from '@/sync/session-actions';
import {
    executeRevertConfirm,
    type RevertConfirmTarget,
    type RevertExecutionResult,
    type ExecuteRevertConfirmOptions,
} from './revertConfirmUtils';

export type { RevertConfirmTarget, RevertExecutionResult, ExecuteRevertConfirmOptions };

export interface RevertConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: RevertConfirmTarget | null;
    onConfirm?: () => Promise<void> | void;
    onSuccess?: (target?: RevertConfirmTarget) => void;
}

export const RevertConfirmDialog: React.FC<RevertConfirmDialogProps> = ({
    open,
    onOpenChange,
    target,
    onConfirm,
    onSuccess,
}) => {
    const { t } = useI18n();
    const [isPending, setIsPending] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const isPendingRef = React.useRef(false);
    const isMountedRef = React.useRef(true);
    const onSuccessRef = React.useRef(onSuccess);
    onSuccessRef.current = onSuccess;
    const onOpenChangeRef = React.useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;
    const onConfirmRef = React.useRef(onConfirm);
    onConfirmRef.current = onConfirm;

    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Clear error when dialog opens or target changes
    React.useEffect(() => {
        if (open) {
            setError(null);
        }
    }, [open, target?.sessionId, target?.messageId]);

    const handleCancel = React.useCallback(() => {
        if (isPendingRef.current) return;
        setError(null);
        onOpenChangeRef.current?.(false);
    }, []);

    const handleOpenChange = React.useCallback(
        (nextOpen: boolean) => {
            if (isPendingRef.current) {
                // Prevent dismissal while pending (Esc / backdrop / wrapper trigger)
                return;
            }
            if (!nextOpen) {
                setError(null);
            }
            onOpenChangeRef.current?.(nextOpen);
        },
        []
    );

    const handleConfirm = React.useCallback(async () => {
        return executeRevertConfirm({
            target,
            isPendingRef,
            isMounted: () => isMountedRef.current,
            setIsPending,
            setError,
            onConfirm: onConfirmRef.current,
            getLatestOnSuccess: () => onSuccessRef.current,
            getLatestOnOpenChange: () => onOpenChangeRef.current,
            performRevert: revertToMessage,
            notifyError: (errorDetail) => {
                toast.error(t('chat.revertDialog.toast.failed'), {
                    description: errorDetail,
                });
            },
        });
    }, [target, t]);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent showCloseButton={!isPending} className="max-w-sm gap-5">
                <DialogHeader>
                    <DialogTitle>{t('chat.revertDialog.title')}</DialogTitle>
                    <DialogDescription className="space-y-2 text-left">
                        <span className="block">{t('chat.revertDialog.description')}</span>
                        <span className="block text-xs text-muted-foreground/80">
                            {t('chat.revertDialog.subagentHelp')}
                        </span>
                    </DialogDescription>
                </DialogHeader>

                {error ? (
                    <div
                        role="alert"
                        className="rounded-lg border border-[var(--status-error)]/30 bg-[color-mix(in_srgb,var(--status-error)_8%,var(--surface-elevated))] p-3 text-xs text-[var(--status-error)] break-words"
                    >
                        <p className="font-semibold">{t('chat.revertDialog.errorTitle')}</p>
                        <p className="mt-1 font-mono text-[11px] leading-relaxed select-text whitespace-pre-wrap">
                            {error}
                        </p>
                    </div>
                ) : null}

                <DialogFooter>
                    <Button
                        type="button"
                        onClick={handleCancel}
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                    >
                        {t('chat.revertDialog.cancel')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleConfirm}
                        size="sm"
                        disabled={isPending}
                        className="gap-1.5"
                    >
                        {isPending ? (
                            <>
                                <RiLoader4Line
                                    className="h-4 w-4 animate-spin text-[var(--foreground-muted)]"
                                    aria-hidden="true"
                                />
                                <span>{t('chat.revertDialog.reverting')}</span>
                            </>
                        ) : (
                            t('chat.revertDialog.confirm')
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default RevertConfirmDialog;
