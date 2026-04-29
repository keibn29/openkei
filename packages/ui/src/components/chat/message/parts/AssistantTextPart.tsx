import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { PlanCard } from '../../PlanCard';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

type AssistantRenderSegment = {
    key: string;
    type: 'markdown' | 'plan';
    content: string;
};

const PLANNER_PLAN_OPEN_TAG = '<planner-plan>';
const PLANNER_PLAN_BLOCK_REGEX = /<planner-plan>([\s\S]*?)<\/planner-plan>/gi;

const normalizePlannerPlanContent = (text: string): string => {
    return text
        .replace(/^(?:[ \t]*\r?\n)+/, '')
        .replace(/(?:\r?\n[ \t]*)+$/, '');
};

const splitAssistantRenderSegments = (text: string): AssistantRenderSegment[] => {
    if (!text.toLowerCase().includes(PLANNER_PLAN_OPEN_TAG)) {
        return [{ key: 'markdown-0', type: 'markdown', content: text }];
    }

    const segments: AssistantRenderSegment[] = [];
    let lastIndex = 0;
    let segmentIndex = 0;

    for (const match of text.matchAll(PLANNER_PLAN_BLOCK_REGEX)) {
        const matchIndex = match.index ?? -1;
        const matchText = match[0] ?? '';
        const planContent = match[1] ?? '';

        if (matchIndex < 0 || matchText.length === 0) {
            continue;
        }

        const leadingText = text.slice(lastIndex, matchIndex);
        if (leadingText.length > 0) {
            segments.push({
                key: `markdown-${segmentIndex}`,
                type: 'markdown',
                content: leadingText,
            });
            segmentIndex += 1;
        }

        const normalizedPlanContent = normalizePlannerPlanContent(planContent);
        if (normalizedPlanContent.trim().length > 0) {
            segments.push({
                key: `plan-${segmentIndex}`,
                type: 'plan',
                content: normalizedPlanContent,
            });
            segmentIndex += 1;
        }

        lastIndex = matchIndex + matchText.length;
    }

    const trailingText = text.slice(lastIndex);
    if (trailingText.length > 0) {
        segments.push({
            key: `markdown-${segmentIndex}`,
            type: 'markdown',
            content: trailingText,
        });
    }

    return segments.length > 0 ? segments : [{ key: 'markdown-0', type: 'markdown', content: text }];
};

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    chatRenderMode?: 'sorted' | 'live';
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    chatRenderMode = 'live',
}) => {
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const isStreaming = chatRenderMode === 'live' && (isStreamingPhase || isCooldownPhase);

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');
    const markdownVariant = part.type === 'reasoning' ? 'reasoning' : 'assistant';
    const containsPlannerPlanBlock = part.type === 'text' && displayTextContent.toLowerCase().includes(PLANNER_PLAN_OPEN_TAG);
    const renderSegments = React.useMemo(
        () => (containsPlannerPlanBlock ? splitAssistantRenderSegments(displayTextContent) : null),
        [containsPlannerPlanBlock, displayTextContent],
    );

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    return (
        <div
            className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
            key={part.id || `${messageId}-text`}
        >
            {renderSegments ? renderSegments.map((segment, index) => {
                if (segment.type === 'plan') {
                    return (
                        <PlanCard
                            key={segment.key}
                            content={segment.content}
                        />
                    );
                }

                if (segment.content.trim().length === 0) {
                    return null;
                }

                return (
                    <MarkdownRenderer
                        key={segment.key}
                        content={segment.content}
                        part={part}
                        messageId={`${messageId}-segment-${index}`}
                        isAnimated={false}
                        isStreaming={isStreaming}
                        disableStreamAnimation={chatRenderMode === 'sorted'}
                        variant={markdownVariant}
                    />
                );
            }) : (
                <MarkdownRenderer
                    content={displayTextContent}
                    part={part}
                    messageId={messageId}
                    isAnimated={false}
                    isStreaming={isStreaming}
                    disableStreamAnimation={chatRenderMode === 'sorted'}
                    variant={markdownVariant}
                />
            )}
        </div>
    );
};

export default React.memo(AssistantTextPart);
