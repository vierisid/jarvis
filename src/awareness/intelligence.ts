/**
 * Awareness Intelligence — Cloud Vision Analysis
 *
 * Escalates screenshots to LLM vision when local OCR detects errors, stuck
 * states, or struggle. Vision calls carry a full screenshot on every request,
 * so they are the single most expensive thing awareness can do — the gate is
 * deliberately narrow and double rate-limited:
 *
 *   - A *signal* escalation (error / stuck / struggle detected locally) is
 *     what cloud vision exists for. It runs on `cooldownMs`.
 *   - An *ambient* escalation ("what is the user up to now?") has no local
 *     signal behind it, only an app switch. It is capped separately by
 *     `ambientCooldownMs`, which is much longer, because otherwise it fires
 *     every cooldown window for as long as the daemon is up.
 *
 * Both run on the `low` tier: these are short, bounded screen descriptions,
 * not reasoning work. On a single-LLM config `low` falls up to `medium`, so
 * this stays correct without any tier wiring — but see visionChat() for the
 * case where `low` is configured with a model that cannot see.
 */

import type { LLMManager } from '../llm/manager.ts';
import type { ContentBlock } from '../llm/provider.ts';
import { guardImageSize, LLMProviderError } from '../llm/provider.ts';
import type { Tier } from '../llm/tiers.ts';
import type { ScreenContext, AwarenessEvent } from './types.ts';

/** Which analysis a claimed escalation should run. */
export type EscalationKind = 'struggle' | 'delta' | 'general';

/** A granted escalation: what to run, plus the token needed to give it back. */
export type EscalationClaim = { kind: EscalationKind; token: number };

const SIGNAL_EVENTS = ['error_detected', 'stuck_detected', 'struggle_detected'];

export class AwarenessIntelligence {
  private llm: LLMManager;
  private lastCloudCallAt = 0;
  private lastAmbientCallAt = 0;
  private cooldownMs: number;
  private ambientCooldownMs: number;
  private visionTier: Tier = 'low';
  /**
   * The one outstanding claim, if any. Captures are processed concurrently
   * (the daemon does not await handleSidecarEvent, and several sidecars can
   * share one instance), so a release has to prove it owns the claim it is
   * undoing — otherwise a slow capture's failed fetch rolls back a *later*
   * capture's claim and reopens the gate while that call is still in flight.
   */
  private outstandingClaim: { token: number; cloud: number; ambient: number } | null = null;
  private nextClaimToken = 1;

  constructor(llm: LLMManager, cooldownMs: number = 30000, ambientCooldownMs: number = 900000) {
    this.llm = llm;
    this.cooldownMs = cooldownMs;
    // An ambient look-around must never be more frequent than a signal one.
    this.ambientCooldownMs = Math.max(ambientCooldownMs, cooldownMs);
  }

  /**
   * Decide whether this capture warrants a cloud vision call and, if so, which
   * analysis to run. Claiming *stamps the cooldown immediately* rather than
   * when the analysis starts: the caller has to await an image fetch between
   * the decision and the call, and without the stamp two concurrent captures
   * both pass the gate and both bill.
   *
   * Returns null when nothing should escalate.
   */
  claimEscalation(context: ScreenContext, events: AwarenessEvent[]): EscalationClaim | null {
    const now = Date.now();

    if (now - this.lastCloudCallAt < this.cooldownMs) {
      return null;
    }

    const hasSignal = events.some(e => SIGNAL_EVENTS.includes(e.type));

    if (!hasSignal) {
      // Ambient path. `isAppSwitch` (not `isSignificantChange`) on purpose:
      // significant-change is true for any window *title* change, and browser
      // tabs, editors and media players retitle constantly, so it is true on
      // nearly every capture.
      if (!context.isAppSwitch) return null;
      if (now - this.lastAmbientCallAt < this.ambientCooldownMs) return null;
      const token = this.stampClaim(now);
      this.lastAmbientCallAt = now;
      return { kind: 'delta', token };
    }

    const token = this.stampClaim(now);
    if (events.some(e => e.type === 'struggle_detected')) return { kind: 'struggle', token };
    return { kind: context.isAppSwitch ? 'delta' : 'general', token };
  }

  private stampClaim(now: number): number {
    const token = this.nextClaimToken++;
    this.outstandingClaim = { token, cloud: this.lastCloudCallAt, ambient: this.lastAmbientCallAt };
    this.lastCloudCallAt = now;
    return token;
  }

  /**
   * Give back the most recent claim. The caller has to fetch the screenshot
   * between claiming and calling, and that fetch can fail (sidecar restarted,
   * file already pruned). Nothing was billed in that case, so holding the
   * cooldown would swallow the next real error or struggle for no reason.
   *
   * Ignored unless `token` is the claim currently outstanding: a claim that has
   * already been superseded by a newer one must not roll the cooldown back
   * underneath it, and a second release of the same token is a no-op.
   */
  releaseEscalation(token: number): void {
    if (!this.outstandingClaim || this.outstandingClaim.token !== token) return;
    this.lastCloudCallAt = this.outstandingClaim.cloud;
    this.lastAmbientCallAt = this.outstandingClaim.ambient;
    this.outstandingClaim = null;
  }

  /**
   * Run one vision call on the cheapest tier that works.
   *
   * The tier map records which model serves a tier, not whether that model can
   * see, and `low` is exactly where someone wires a cheap text-only model. A
   * tier is only fallen up from when it is *unconfigured*, and a "this model
   * does not support images" 400 is a `bad_request` that LLMManager
   * deliberately will not fail over on — so a text-only `low` model would fail
   * every call forever and the caller would see nothing but empty analyses.
   * On the first failure, drop to `medium` for the life of the process.
   */
  private async visionChat(
    subsystem: string,
    content: ContentBlock[],
    maxTokens: number,
  ): Promise<string> {
    const messages = [{ role: 'user' as const, content }];
    try {
      const response = await this.llm.chatTier(this.visionTier, subsystem, messages, { max_tokens: maxTokens });
      return response.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.visionTier !== 'low' || !looksLikeVisionRefusal(err)) {
        // A rate limit, timeout or 5xx says nothing about what the model can
        // do. Downgrading on those would hand the whole subsystem to the
        // expensive tier after one blip — the opposite of the point.
        console.error(`[Intelligence] ${subsystem} failed:`, msg);
        return '';
      }

      console.warn(
        `[Intelligence] the low tier cannot accept images (${msg}) — using the medium tier for awareness vision from here on.`,
      );
      this.visionTier = 'medium';
      try {
        const response = await this.llm.chatTier('medium', subsystem, messages, { max_tokens: maxTokens });
        return response.content;
      } catch (retryErr) {
        console.error(`[Intelligence] ${subsystem} failed:`, retryErr instanceof Error ? retryErr.message : retryErr);
        return '';
      }
    }
  }

  /**
   * General screen analysis — what is the user doing?
   */
  async analyzeGeneral(imageBase64: string, context: ScreenContext): Promise<string> {
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

    return this.visionChat('awareness_general', content, 300);
  }

  /**
   * Delta-focused analysis — what changed between two captures?
   */
  async analyzeDelta(
    imageBase64: string,
    current: ScreenContext,
    previous: ScreenContext | null
  ): Promise<string> {
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

    return this.visionChat('awareness_delta', content, 200);
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
    const imageBlock: ContentBlock = guardImageSize({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });

    const prompt = this.buildStrugglePrompt(context, appCategory, signals, ocrPreview);
    const content: ContentBlock[] = [imageBlock, { type: 'text', text: prompt }];

    return this.visionChat('awareness_struggle', content, 600);
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

/**
 * Whether an error means "this model cannot see", as opposed to "this call
 * went wrong". Only the former justifies giving up on the tier permanently.
 *
 * A provider that rejects an image answers with a 400/404 — never a 429 or a
 * 5xx, which are about the request, not the model. The message check narrows
 * it further, since a bad_request can also mean a malformed prompt.
 */
function looksLikeVisionRefusal(err: unknown): boolean {
  const code = err instanceof LLMProviderError ? err.code : undefined;
  if (code !== undefined && code !== 'bad_request' && code !== 'not_found') return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(image|images|vision|multimodal|image_url|media type)\b/i.test(msg);
}
