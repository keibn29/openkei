import type { SessionContextUsage } from '@/stores/types/sessionTypes';

export const createEmptyContextUsage = (contextLimit: number, outputLimit: number): SessionContextUsage => ({
  totalTokens: 0,
  totalCost: 0,
  percentage: 0,
  contextLimit: contextLimit > 0 ? contextLimit : 0,
  outputLimit: outputLimit > 0 ? outputLimit : undefined,
  normalizedOutput: outputLimit > 0 ? 0 : undefined,
  thresholdLimit: contextLimit > 0 ? contextLimit : 200000,
});

export const resolveDisplayContextUsage = (
  sessionId: string | null | undefined,
  contextUsage: SessionContextUsage | null | undefined,
  contextLimit: number,
  outputLimit: number,
): SessionContextUsage | null => {
  if (!sessionId) {
    return null;
  }

  return contextUsage ?? createEmptyContextUsage(contextLimit, outputLimit);
};
