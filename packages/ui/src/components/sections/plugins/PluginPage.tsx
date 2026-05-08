import React from 'react';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
  RiExternalLinkLine,
  RiInformationLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type PluginEntry = {
  name: string;
  type: 'config';
  scope: string | null;
  filePath: string | null;
  description?: string;
};

export const PluginPage: React.FC = () => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();
  const [items, setItems] = React.useState<PluginEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  React.useEffect(() => {
    if (!isVSCode) return;
    let cancelled = false;

    const fetchPlugins = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/plugins/list');
        if (!res.ok) throw new Error(`Failed to load plugins (${res.status})`);
        const data = (await res.json()) as PluginEntry[];
        if (!cancelled) setItems(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void fetchPlugins();
    return () => { cancelled = true; };
  }, [isVSCode]);

  const handleOpenFile = React.useCallback((filePath: string | null) => {
    if (!filePath || !runtimeApis?.editor) return;
    void runtimeApis.editor.openFile(filePath);
  }, [runtimeApis]);

  if (!isVSCode) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="typography-body">{t('settings.plugins.notAvailable')}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
        <div className="mb-6">
          <h2 className="typography-ui-header font-semibold text-foreground">{t('settings.plugins.title')}</h2>
          <p className="typography-meta text-muted-foreground mt-1">{t('settings.plugins.description')}</p>
        </div>

        {/* Reload warning banner */}
        <div className="mb-6 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-3 py-2.5 flex items-start gap-2">
          <RiInformationLine className="h-4 w-4 shrink-0 mt-0.5 text-[var(--status-warning)]" />
          <p className="typography-micro text-muted-foreground">{t('settings.plugins.reloadWarning')}</p>
        </div>

        {isLoading && (
          <div className="py-12 text-center text-muted-foreground typography-ui-label">
            {t('settings.plugins.loading')}
          </div>
        )}

        {error && (
          <div className="py-12 text-center">
            <p className="typography-ui-label text-[var(--status-error)]">{error}</p>
          </div>
        )}

        {!isLoading && !error && items.length === 0 && (
          <div className="py-12 text-center text-muted-foreground">
            <p className="typography-ui-label font-medium">{t('settings.plugins.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.plugins.empty.description')}</p>
          </div>
        )}

        {!isLoading && !error && items.length > 0 && (
          <div className="space-y-1">
            {items.map((entry) => {
              const isClickable = !!entry.filePath;
              return (
                <button
                  key={entry.name}
                  type="button"
                  disabled={!isClickable}
                  onClick={() => handleOpenFile(entry.filePath)}
                  className={cn(
                    'flex w-full items-center rounded-md px-3 py-2 text-left transition-colors duration-150',
                    isClickable
                      ? 'hover:bg-[var(--interactive-hover)] cursor-pointer'
                      : 'cursor-default opacity-60',
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="typography-ui-label font-normal text-foreground truncate">{entry.name}</span>
                      {entry.scope && (
                        <span className={cn(
                          'typography-micro px-1 rounded leading-none py-0.5',
                          entry.scope === 'project'
                            ? 'bg-[var(--status-warning)]/10 text-[var(--status-warning)]'
                            : 'bg-muted-foreground/10 text-muted-foreground',
                        )}>
                          {entry.scope}
                        </span>
                      )}
                      {entry.name === 'oh-my-openkei' && entry.filePath && (
                        <span className="typography-micro px-1 rounded leading-none py-0.5 bg-[var(--status-success)]/10 text-[var(--status-success)]">
                          {t('settings.plugins.ohMyOpenkei.enabled')}
                        </span>
                      )}
                      {entry.name === 'oh-my-openkei' && !entry.filePath && (
                        <span className="typography-micro px-1 rounded leading-none py-0.5 bg-muted-foreground/10 text-muted-foreground">
                          {t('settings.plugins.ohMyOpenkei.notConfigured')}
                        </span>
                      )}
                    </div>
                    {entry.filePath && (
                      <div className="typography-micro text-muted-foreground/60 truncate mt-0.5 font-mono">
                        {entry.filePath}
                      </div>
                    )}
                    {entry.description && (
                      <div className="typography-micro text-muted-foreground/50 truncate mt-0.5">
                        {entry.description}
                      </div>
                    )}
                  </div>
                  {isClickable && (
                    <RiExternalLinkLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </ScrollableOverlay>
  );
};
