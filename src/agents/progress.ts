import type { LLMToolCall } from '../llm/provider.ts';

/**
 * Human-facing acknowledgment used only when a model silently emits tools.
 * This is activity narration, not hidden reasoning: it says what Jarvis is
 * doing without exposing chain-of-thought or inventing intermediate results.
 */
export function progressAcknowledgement(toolCalls: LLMToolCall[]): string {
  const first = toolCalls[0];
  if (!first) return 'I’m working on that now.';

  if (first.name === 'delegate') {
    const template = String(first.arguments.template ?? '').toLowerCase();
    if (template === 'research') return 'I’m looking into that now and I’ll report back.';
    if (template === 'code') return 'I’m checking the relevant code now.';
    if (template === 'plan') return 'I’m working through the plan now.';
    if (template === 'write') return 'I’m drafting that now.';
    return 'I’m working on that now.';
  }

  if (first.name === 'check_task') return 'I’m checking on that task now.';
  if (first.name === 'resume_task') return 'I’m picking that task back up now.';

  if (/^(read|list|get|find|search|inspect|browser_|web_)/i.test(first.name)) {
    return 'I’m checking the relevant details now.';
  }
  if (/^(write|create|update|edit|delete|run|execute|send|desktop_)/i.test(first.name)) {
    return 'I’m working through that now.';
  }
  return 'I’m working on that now.';
}
