/**
 * Struggle Detector — Behavioral Analysis
 *
 * Detects when the user is actively working but making no progress:
 * trial-and-error editing, repeated failing commands, undo cycles.
 * Complements stuck detection (which only fires when screen is unchanging).
 */

// ── Types ──

export type AppCategory =
  | 'code_editor'
  | 'terminal'
  | 'browser'
  | 'creative_app'
  | 'puzzle_game'
  | 'general';

export type StruggleSignal = {
  name: string;
  score: number;   // 0.0 - 1.0
  detail: string;
};

export type StruggleAnalysis = {
  isStruggling: boolean;
  compositeScore: number;
  signals: StruggleSignal[];
  appCategory: AppCategory;
  appName: string;
  windowTitle: string;
  durationMs: number;
};

type Snapshot = {
  timestamp: number;
  ocrHash: string;
  ocrText: string;
  appName: string;
  outputHash: string; // hash of bottom 500 chars (terminal/compiler output area)
};

// ── Constants ──

const MAX_SNAPSHOTS = 30;          // ~3.5 min at 7s intervals
const WINDOW_MS = 3.5 * 60 * 1000; // 3.5 minutes
const MIN_SNAPSHOTS = 8;           // ~56s of data before analysis

const SIGNAL_WEIGHTS = {
  trialAndError: 0.30,
  undoRevert: 0.25,
  repeatedOutput: 0.25,
  lowProgress: 0.20,
};

const STRUGGLE_THRESHOLD = 0.5;

// ── App Classification Patterns ──

const CODE_EDITORS = /\b(VS\s?Code|Visual Studio Code|IntelliJ|WebStorm|PyCharm|CLion|GoLand|RubyMine|Sublime|Atom|vim|nvim|neovim|Emacs|Cursor|Zed|nano|Code - OSS|code-oss)\b/i;
const TERMINALS = /\b(Terminal|iTerm|Konsole|Alacritty|Warp|kitty|GNOME Terminal|Windows Terminal|PowerShell|pwsh|cmd\.exe|bash|zsh|tmux|screen|Hyper)\b/i;
const BROWSERS = /\b(Chrome|Chromium|Firefox|Brave|Edge|Safari|Opera|Arc|Vivaldi)\b/i;
const CREATIVE_APPS = /\b(Photoshop|Figma|GIMP|Blender|Illustrator|Inkscape|Sketch|Affinity|Canva|Lightroom|Premiere|DaVinci|After Effects|Krita|Paint\.NET)\b/i;
const PUZZLE_INDICATORS = /\b(score|level|moves|timer|puzzle|sudoku|wordle|crossword|chess|2048|minesweeper|solitaire|tetris)\b/i;

// ── Main Class ──

export class StruggleDetector {
  private snapshots: Snapshot[] = [];
  private lastStruggleEmitAt = 0;
  private struggleStartedAt: number | null = null;
  private graceMs: number;
  private cooldownMs: number;

  constructor(opts?: { graceMs?: number; cooldownMs?: number }) {
    this.graceMs = opts?.graceMs ?? 120_000;
    this.cooldownMs = opts?.cooldownMs ?? 180_000;
  }

  /**
   * Evaluate current capture for struggle patterns.
   * Returns StruggleAnalysis when struggle is confirmed (past grace + cooldown), null otherwise.
   */
  evaluate(ocrText: string, appName: string, windowTitle: string, timestamp: number): StruggleAnalysis | null {
    const ocrHash = simpleHash(ocrText);
    const outputHash = simpleHash(ocrText.slice(-500));

    this.snapshots.push({ timestamp, ocrHash, ocrText, appName, outputHash });

    // Evict old entries
    const cutoff = timestamp - WINDOW_MS;
    this.snapshots = this.snapshots.filter(s => s.timestamp > cutoff);
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS);
    }

    // Need enough data
    if (this.snapshots.length < MIN_SNAPSHOTS) return null;

    // All snapshots must be from the same app (struggle resets on app switch)
    if (!this.snapshots.every(s => s.appName === appName)) return null;

    // Compute signals
    const signals: StruggleSignal[] = [];

    const trialAndError = this.detectTrialAndError();
    signals.push(trialAndError);

    const undoRevert = this.detectUndoRevert();
    signals.push(undoRevert);

    const repeatedOutput = this.detectRepeatedOutput();
    signals.push(repeatedOutput);

    const lowProgress = this.detectLowProgress();
    signals.push(lowProgress);

    // Composite score
    const compositeScore =
      trialAndError.score * SIGNAL_WEIGHTS.trialAndError +
      undoRevert.score * SIGNAL_WEIGHTS.undoRevert +
      repeatedOutput.score * SIGNAL_WEIGHTS.repeatedOutput +
      lowProgress.score * SIGNAL_WEIGHTS.lowProgress;

    if (compositeScore < STRUGGLE_THRESHOLD) {
      this.struggleStartedAt = null;
      return null;
    }

    // Grace period: don't fire immediately
    if (this.struggleStartedAt === null) {
      this.struggleStartedAt = timestamp;
      return null;
    }
    if (timestamp - this.struggleStartedAt < this.graceMs) {
      return null;
    }

    // Cooldown: don't fire too often
    if (timestamp - this.lastStruggleEmitAt < this.cooldownMs) {
      return null;
    }

    // Fire!
    this.lastStruggleEmitAt = timestamp;
    this.struggleStartedAt = null;

    const appCategory = this.classifyApp(appName, windowTitle, ocrText);
    const durationMs = timestamp - this.snapshots[0]!.timestamp;

    return {
      isStruggling: true,
      compositeScore,
      signals,
      appCategory,
      appName,
      windowTitle,
      durationMs,
    };
  }

  /**
   * Classify the current app into a category for prompt selection.
   */
  classifyApp(appName: string, windowTitle: string, ocrText: string): AppCategory {
    const combined = `${appName} ${windowTitle}`;

    if (CODE_EDITORS.test(combined)) return 'code_editor';
    if (TERMINALS.test(combined)) return 'terminal';
    if (CREATIVE_APPS.test(combined)) return 'creative_app';
    if (BROWSERS.test(combined)) return 'browser';

    // Puzzle game detection: check window title + OCR heuristics
    if (PUZZLE_INDICATORS.test(combined) || PUZZLE_INDICATORS.test(ocrText.slice(0, 500))) {
      return 'puzzle_game';
    }

    return 'general';
  }

  /**
   * Reset state — call on app switch.
   */
  reset(): void {
    this.snapshots = [];
    this.struggleStartedAt = null;
  }

  // ── Signal Detectors ──

  /**
   * Signal 1: Trial-and-error editing.
   * High ratio of unique OCR hashes = many small changes that don't converge.
   */
  private detectTrialAndError(): StruggleSignal {
    const total = this.snapshots.length;
    const uniqueHashes = new Set(this.snapshots.map(s => s.ocrHash)).size;
    const ratio = uniqueHashes / total;

    // If > 70% of captures are unique AND we have enough unique ones,
    // the user is making lots of small changes without settling
    if (uniqueHashes >= 10 && ratio > 0.7) {
      const score = Math.min(1.0, (ratio - 0.5) * 3);
      return {
        name: 'trial_and_error',
        score,
        detail: `${uniqueHashes}/${total} unique screen states (${Math.round(ratio * 100)}% unique)`,
      };
    }

    return { name: 'trial_and_error', score: 0, detail: 'Normal editing pattern' };
  }

  /**
   * Signal 2: Undo/revert patterns.
   * Detects when current OCR hash matches a hash from 2-5 snapshots ago (text reverted).
   */
  private detectUndoRevert(): StruggleSignal {
    let revertCount = 0;

    for (let i = 2; i < this.snapshots.length; i++) {
      const current = this.snapshots[i]!.ocrHash;
      // Check if current matches any of the 2-5 snapshots before it
      for (let k = 2; k <= Math.min(5, i); k++) {
        if (current === this.snapshots[i - k]!.ocrHash) {
          revertCount++;
          break; // count each revert once
        }
      }
    }

    if (revertCount >= 2) {
      const score = Math.min(1.0, revertCount / 5);
      return {
        name: 'undo_revert',
        score,
        detail: `${revertCount} revert cycles detected (text returning to previous states)`,
      };
    }

    return { name: 'undo_revert', score: 0, detail: 'No revert patterns' };
  }

  /**
   * Signal 3: Repeated output.
   * Bottom of screen (terminal/compiler output) stays the same across many captures.
   */
  private detectRepeatedOutput(): StruggleSignal {
    const outputHashes = this.snapshots.map(s => s.outputHash);
    const counts = new Map<string, number>();

    for (const h of outputHashes) {
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }

    // Find most repeated output hash
    let maxCount = 0;
    for (const count of counts.values()) {
      maxCount = Math.max(maxCount, count);
    }

    const pct = maxCount / this.snapshots.length;

    if (pct > 0.4 && maxCount >= 6) {
      const score = Math.min(1.0, (pct - 0.3) / 0.4);
      return {
        name: 'repeated_output',
        score,
        detail: `Same output in ${maxCount}/${this.snapshots.length} captures (${Math.round(pct * 100)}%)`,
      };
    }

    return { name: 'repeated_output', score: 0, detail: 'Output is changing normally' };
  }

  /**
   * Signal 4: Low meaningful progress.
   * Small average edit distance between consecutive snapshots despite many captures.
   */
  private detectLowProgress(): StruggleSignal {
    if (this.snapshots.length < 3) {
      return { name: 'low_progress', score: 0, detail: 'Not enough data' };
    }

    let totalDist = 0;
    let comparisons = 0;

    for (let i = 1; i < this.snapshots.length; i++) {
      const dist = cheapEditDistance(
        this.snapshots[i - 1]!.ocrText,
        this.snapshots[i]!.ocrText
      );
      totalDist += dist;
      comparisons++;
    }

    const avgDist = comparisons > 0 ? totalDist / comparisons : 0;

    // If average edit distance is small (< 100 chars difference per capture),
    // the user is making minor tweaks without significant progress
    if (avgDist > 0 && avgDist < 100) {
      const score = Math.min(1.0, 1.0 - (avgDist / 200));
      return {
        name: 'low_progress',
        score: Math.max(0, score),
        detail: `Avg ${Math.round(avgDist)} chars changed per capture (minor tweaks)`,
      };
    }

    return { name: 'low_progress', score: 0, detail: `Avg ${Math.round(avgDist)} chars changed (making progress)` };
  }
}

// ── Helpers ──

/**
 * Simple non-cryptographic hash for fast comparison.
 */
function simpleHash(str: string): string {
  let hash = 0;
  const sample = str.slice(0, 2000);
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

/**
 * Cheap O(n) edit distance — counts character-position mismatches.
 * Not a full Levenshtein, but sufficient for "are these texts similar?"
 */
function cheapEditDistance(a: string, b: string): number {
  const maxLen = Math.min(a.length, b.length, 1000);
  let diffs = 0;
  for (let i = 0; i < maxLen; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) diffs++;
  }
  diffs += Math.abs(a.length - b.length);
  return diffs;
}
