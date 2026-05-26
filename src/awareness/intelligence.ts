/**
 * Awareness Intelligence — Cloud Vision Analysis
 *
 * Escalates screenshots to LLM vision when local OCR detects errors,
 * stuck states, or significant context changes. Rate-limited to avoid
 * excessive API calls.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { ContentBlock } from '../llm/provider.ts';
import { guardImageSize } from '../llm/provider.ts';
import type { ScreenContext, AwarenessEvent } from './types.ts';

export class AwarenessIntelligence {
  private llm: LLMManager;
  private lastCloudCallAt = 0;
  private cooldownMs: number;

  constructor(llm: LLMManager, cooldownMs: number = 30000) {
    this.llm = llm;
    this.cooldownMs = cooldownMs;
  }

  /**
   * Determine if a capture warrants cloud vision analysis.
   */
  shouldEscalateToCloud(context: ScreenContext, events: AwarenessEvent[]): boolean {
    const now = Date.now();

    // Rate limit
    if (now - this.lastCloudCallAt < this.cooldownMs) {
      return false;
    }

    // Escalate for error detection
    if (events.some(e => e.type === 'error_detected')) {
      return true;
    }

    // Escalate for stuck detection
    if (events.some(e => e.type === 'stuck_detected')) {
      return true;
    }

    // Escalate for struggle detection (needs vision for deep analysis)
    if (events.some(e => e.type === 'struggle_detected')) {
      return true;
    }

    // Escalate for significant context changes
    if (context.isSignificantChange) {
      return true;
    }

    // Escalate for very short/empty OCR (image-heavy screen)
    if (context.ocrText.trim().length < 20) {
      return true;
    }

    return false;
  }

  /**
   * General screen analysis — what is the user doing?
   */
  async analyzeGeneral(imageBase64: string, context: ScreenContext): Promise<string> {
    this.lastCloudCallAt = Date.now();

    const imageBlock: ContentBlock = guardImageSize({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });

    const content: ContentBlock[] = [
      imageBlock,
      {
        type: 'text',
        text: `Analyze this screenshot. The user is in "${context.appName}" (window: "${context.windowTitle}").
OCR extracted: "${context.ocrText.slice(0, 500)}"

Provide a concise analysis:
1. What is the user doing right now? (1 sentence)
2. Any errors or issues visible? (yes/no + detail if yes)
3. Any actionable suggestions? (1-2 if applicable)

Be brief and direct. No preamble.`,
      },
    ];

    try {
      const response = await this.llm.chatTier(
        'medium',
        'awareness_general',
        [{ role: 'user', content }],
        { max_tokens: 300 },
      );
      return response.content;
    } catch (err) {
      console.error('[Intelligence] General analysis failed:', err instanceof Error ? err.message : err);
      return '';
    }
  }

  /**
   * Delta-focused analysis — what changed between two captures?
   */
  async analyzeDelta(
    imageBase64: string,
    current: ScreenContext,
    previous: ScreenContext | null
  ): Promise<string> {
    this.lastCloudCallAt = Date.now();

    const imageBlock: ContentBlock = guardImageSize({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });

    const previousInfo = previous
      ? `Previous: "${previous.appName}" — "${previous.windowTitle}"\nPrevious OCR: "${previous.ocrText.slice(0, 300)}"`
      : 'No previous context (first capture).';

    const content: ContentBlock[] = [
      imageBlock,
      {
        type: 'text',
        text: `The user's screen changed. Analyze the delta.

Current: "${current.appName}" — "${current.windowTitle}"
Current OCR: "${current.ocrText.slice(0, 300)}"

${previousInfo}

What changed and why? Note any:
- Task transitions (starting/finishing something)
- Errors or problems that appeared
- Patterns worth learning (user habits)

Be concise. 2-3 sentences max.`,
      },
    ];

    try {
      const response = await this.llm.chatTier(
        'medium',
        'awareness_delta',
        [{ role: 'user', content }],
        { max_tokens: 200 },
      );
      return response.content;
    } catch (err) {
      console.error('[Intelligence] Delta analysis failed:', err instanceof Error ? err.message : err);
      return '';
    }
  }

  /**
   * Deep struggle analysis — app-category-aware screenshot analysis.
   * Returns specific, actionable guidance for the user's situation.
   */
  async analyzeStruggle(
    imageBase64: string,
    context: ScreenContext,
    appCategory: string,
    signals: Array<{ name: string; score: number; detail: string }>,
    ocrPreview: string
  ): Promise<string> {
    this.lastCloudCallAt = Date.now();

    const imageBlock: ContentBlock = guardImageSize({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });

    const prompt = this.buildStrugglePrompt(context, appCategory, signals, ocrPreview);
    const content: ContentBlock[] = [imageBlock, { type: 'text', text: prompt }];

    try {
      const response = await this.llm.chatTier(
        'medium',
        'awareness_struggle',
        [{ role: 'user', content }],
        { max_tokens: 600 },
      );
      return response.content;
    } catch (err) {
      console.error('[Intelligence] Struggle analysis failed:', err instanceof Error ? err.message : err);
      return '';
    }
  }

  private buildStrugglePrompt(
    context: ScreenContext,
    appCategory: string,
    signals: Array<{ name: string; score: number; detail: string }>,
    ocrPreview: string
  ): string {
    const signalSummary = signals
      .filter(s => s.score > 0.3)
      .map(s => `- ${s.name}: ${s.detail}`)
      .join('\n');

    const base = `The user appears to be struggling in "${context.appName}" (window: "${context.windowTitle}").
Behavioral signals detected:
${signalSummary}

OCR text from screen:
"${ocrPreview}"

`;

    const categoryPrompts: Record<string, string> = {
      code_editor: `You are looking at a code editor. The user has been editing the same area repeatedly without making progress.

Analyze the visible code carefully:
1. Look for syntax errors (missing brackets, semicolons, typos in keywords)
2. Look for logic errors (wrong variable names, incorrect conditions, off-by-one)
3. Look for missing imports or undefined variables
4. Look for type errors if TypeScript/typed language
5. Check the error panel/terminal output if visible

Provide the SPECIFIC fix. Say exactly what line has the issue and what to change. If you can see an error message, explain what it means and how to fix it.`,

      terminal: `You are looking at a terminal/CLI. The user has been running commands that keep failing.

Analyze the terminal output:
1. Identify the exact error message
2. Determine if it's a wrong command, missing package, permission issue, or path problem
3. Provide the corrected command they should run
4. If it's a build/compile error, explain the root cause

Give the EXACT command to run. Start with the fix, not an explanation.`,

      browser: `You are looking at a web browser. The user seems to be struggling to accomplish something.

Analyze what's visible:
1. What is the user trying to do? (fill a form, find information, navigate, etc.)
2. Is there a UI element they might be missing?
3. Is there an error on the page?
4. Are they on the wrong page for what they need?

Guide them to the specific button, link, or action they need.`,

      creative_app: `You are looking at a creative application (design/art/video tool). The user seems to be looking for a feature or struggling with a technique.

Analyze the interface:
1. What tool/feature appears to be selected?
2. What is the user trying to create or modify?
3. Is there a more appropriate tool for what they're doing?
4. Are there keyboard shortcuts that would help?

Name the specific tool, menu item, or keyboard shortcut they need. Be precise about where it is in the interface.`,

      puzzle_game: `You are looking at a puzzle or game. The user has been stuck on this for a while.

Analyze the game state:
1. What type of puzzle is this?
2. What is the current state of the board/puzzle?
3. What moves are available?
4. What is the optimal next move or strategy?

Suggest the next 1-2 specific moves. Be precise about positions on the screen.`,

      general: `The user has been struggling with this application for a while without making progress.

Analyze the screen:
1. What is the user trying to accomplish?
2. What obstacle or confusion might they be facing?
3. What specific action should they take next?

Provide clear, actionable guidance.`,
    };

    return base + (categoryPrompts[appCategory] ?? categoryPrompts.general) +
      '\n\nBe concise but specific. No preamble. Start with the most important insight or fix.';
  }

  /**
   * Summarize an activity session for storage.
   */
  async summarizeSession(
    apps: string[],
    captureCount: number,
    durationMinutes: number,
    sampleOcrTexts: string[]
  ): Promise<{ topic: string; summary: string }> {
    const ocrSample = sampleOcrTexts.slice(0, 5).map((t, i) => `[${i + 1}] ${t.slice(0, 200)}`).join('\n');

    try {
      // Session summary is a text-only structured extraction - use low tier.
      const response = await this.llm.chatTier(
        'low',
        'awareness_session_summary',
        [{
          role: 'user',
          content: `Summarize this activity session:
- Apps used: ${apps.join(', ')}
- Duration: ${durationMinutes} minutes
- Captures: ${captureCount}

OCR samples from the session:
${ocrSample}

Respond in JSON: { "topic": "short topic (3-5 words)", "summary": "1-2 sentence summary" }`,
        }],
        { max_tokens: 150 }
      );

      try {
        // Try to extract JSON from response
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return {
            topic: parsed.topic || 'Unknown activity',
            summary: parsed.summary || response.content,
          };
        }
      } catch { /* parse failure, fall through */ }

      return { topic: 'Activity session', summary: response.content.slice(0, 200) };
    } catch (err) {
      console.error('[Intelligence] Session summary failed:', err instanceof Error ? err.message : err);
      return {
        topic: apps.length > 0 ? `${apps[0]} session` : 'Activity session',
        summary: `${durationMinutes}min session using ${apps.join(', ')}`,
      };
    }
  }
}
