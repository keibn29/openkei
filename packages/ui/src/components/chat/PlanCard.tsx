import React from 'react';
import { RiListCheck3, RiFileCopyLine, RiCheckLine, RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react';
import { SimpleMarkdownRenderer } from './MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';

interface PlanCardProps {
  content: string;
  className?: string;
}

const COLLAPSE_LINE_THRESHOLD = 12;

export const PlanCard: React.FC<PlanCardProps> = React.memo(({
  content,
  className,
}) => {
  const { t } = useI18n();
  const trimmedContent = content.trim();
  const [copied, setCopied] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const copiedTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    };
  }, []);

  if (!trimmedContent) {
    return null;
  }

  const lineCount = trimmedContent.split('\n').length;
  const isCollapsible = lineCount > COLLAPSE_LINE_THRESHOLD;
  const isCollapsed = isCollapsible && !expanded;

  const handleCopy = async () => {
    const result = await copyTextToClipboard(trimmedContent);
    if (result.ok) {
      setCopied(true);
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      copiedTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
      }, 1200);
    }
  };

  return (
    <section
      className={cn(
        'mx-5 my-4 overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--primary-base)_14%,var(--interactive-border))] bg-[color-mix(in_srgb,var(--surface-subtle)_82%,var(--surface-elevated))] shadow-[0_14px_16px_-20px_color-mix(in_srgb,var(--primary-base)_70%,transparent)] sm:mx-8',
        className,
      )}
      data-chat-card="planner-plan"
    >
      <div className="flex items-center justify-between border-b border-[color-mix(in_srgb,var(--primary-base)_14%,var(--interactive-border))] bg-[color-mix(in_srgb,var(--surface-subtle)_96%,var(--surface-elevated))] px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-muted)] text-[var(--surface-mutedForeground)]">
            <RiListCheck3 className="h-3.5 w-3.5" />
          </div>
          <span className="typography-meta font-medium text-[var(--surface-foreground)]">
            {t('layout.mainTab.plan')}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={handleCopy}
          className="h-6 w-6 p-0"
          title={t('planView.actions.copyPlanContents')}
          aria-label={t('planView.actions.copyPlanContents')}
        >
          {copied ? (
            <RiCheckLine className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
          ) : (
            <RiFileCopyLine className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <div className={cn('px-3 py-2.5 relative', isCollapsed && 'max-h-64 overflow-hidden')}>
        <SimpleMarkdownRenderer content={trimmedContent} variant="assistant" />
        {isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-[color-mix(in_srgb,var(--surface-subtle)_82%,var(--surface-elevated))] to-transparent" />
        )}
      </div>

      {isCollapsible && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="h-8 w-full justify-center gap-1 rounded-none border-t border-[var(--interactive-border)] px-3 text-[var(--surface-mutedForeground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]"
        >
          {expanded ? (
            <>
              <RiArrowUpSLine className="h-4 w-4" />
              <span className="typography-micro">{t('inlineComment.actions.showLess')}</span>
            </>
          ) : (
            <>
              <RiArrowDownSLine className="h-4 w-4" />
              <span className="typography-micro">{t('inlineComment.actions.showMore')}</span>
            </>
          )}
        </Button>
      )}
    </section>
  );
});

PlanCard.displayName = 'PlanCard';
