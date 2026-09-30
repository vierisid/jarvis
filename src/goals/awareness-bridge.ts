/**
 * Awareness → Goals Bridge
 *
 * Subscribes to awareness events and fuzzy-matches detected context
 * (destination apps/windows and ended-session apps) against active goals.
 * Records possible activity as 'auto_detected'; never measures business progress.
 * Feeds the evening review with detected activity.
 */

import { normalizeAwarenessActivityEvent } from '../awareness/activity-events.ts';
import type { AwarenessActivityEvent } from '../awareness/activity-events.ts';
import * as vault from '../vault/goals.ts';

export type AwarenessGoalMatch = {
  goalId: string;
  goalTitle: string;
  matchScore: number;
  matchedTerms: string[];
  source: string;
  eventType: AwarenessActivityEvent['type'];
  observedAt: number;
};

/**
 * Process an awareness event and check if it relates to any active goals.
 * Returns any matches found so the caller can log them.
 */
export function matchAwarenessToGoals(
  event: unknown,
): AwarenessGoalMatch[] {
  const observation = normalizeAwarenessActivityEvent(event);
  if (!observation) return [];
  const activity = extractActivity(observation);
  if (!activity) return [];
  const activeGoals = vault.findGoals({ status: 'active' });
  if (activeGoals.length === 0) return [];

  // Extract searchable text from awareness event
  const eventText = activity.text;
  if (!eventText) return [];

  const eventWords = tokenize(eventText);
  if (eventWords.length === 0) return [];

  const matches: AwarenessGoalMatch[] = [];

  for (const goal of activeGoals) {
    const goalWords = tokenize(`${goal.title} ${goal.description} ${goal.success_criteria}`);
    if (goalWords.length === 0) continue;

    const { score, matched } = fuzzyMatch(eventWords, goalWords);

    // Threshold: require at least 2 matching terms and 0.15 score
    if (score >= 0.15 && matched.length >= 2) {
      matches.push({
        goalId: goal.id,
        goalTitle: goal.title,
        matchScore: score,
        matchedTerms: matched,
        source: activity.source,
        eventType: observation.type,
        observedAt: observation.timestamp,
      });
    }
  }

  // Sort by match score descending
  matches.sort((a, b) => b.matchScore - a.matchScore);

  return matches;
}

/**
 * Log a possible activity note for matched goals, without changing scores.
 * Only logs if the goal hasn't had a recent auto-detection (within 30 min).
 */
export function logAutoDetectedProgress(
  matches: AwarenessGoalMatch[],
): void {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;

  for (const match of matches) {
    // Check for recent auto-detection to avoid spam
    const hasRecentAutoDetect = vault.hasRecentAutoDetectedProgress(match.goalId, now - thirtyMinutes);

    if (hasRecentAutoDetect) continue;

    const goal = vault.getGoal(match.goalId);
    if (!goal || goal.status !== 'active') continue;

    // Log progress entry (no score change, just detection)
    vault.addProgressEntry(
      match.goalId,
      'auto_detected',
      goal.score,
      goal.score, // no automatic score change
      `Possible goal-related activity: ${match.eventType} via ${match.source} (matched: ${match.matchedTerms.join(', ')}; observed at ${new Date(match.observedAt).toISOString()}). This is an activity hint, not verified progress.`,
      'awareness',
    );
  }
}

/** Entry point shared by the daemon and serialized-producer integration tests. */
export function recordGoalAwarenessActivity(event: unknown): AwarenessGoalMatch[] {
  const matches = matchAwarenessToGoals(event);
  logAutoDetectedProgress(matches);
  return matches;
}

function extractActivity(event: AwarenessActivityEvent): { text: string; source: string } | null {
  switch (event.type) {
    case 'context_changed': {
      // The departed app/window is history, not evidence of the new activity.
      const app = event.data.toApp.trim();
      const window = event.data.toWindow.trim();
      return { text: `${app} ${window}`, source: app || window || 'awareness' };
    }
    case 'session_ended': {
      if (!event.data.sessionId?.trim()) return null;
      // A session-end payload has apps, not a generated summary or OCR text.
      const apps = event.data.apps.map(app => app.trim()).filter(Boolean);
      return { text: apps.join(' '), source: apps.join(', ') || 'awareness' };
    }
  }
}

// Common words to filter from matching
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'and', 'but', 'or', 'not', 'no', 'if', 'than', 'so', 'up', 'out',
  'that', 'this', 'it', 'its', 'my', 'your', 'his', 'her', 'our',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some',
  'new', 'file', 'window', 'app', 'application', 'open', 'close',
]);

/**
 * Tokenize text into meaningful words (lowercase, filtered).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Fuzzy match: check how many of the event words overlap with goal words.
 * Returns a score (0-1) and the matched terms.
 */
function fuzzyMatch(
  eventWords: string[],
  goalWords: string[],
): { score: number; matched: string[] } {
  const goalSet = new Set(goalWords);
  const matched: string[] = [];

  for (const word of eventWords) {
    if (goalSet.has(word)) {
      matched.push(word);
    } else {
      // Partial match: check if event word is substring of any goal word or vice versa
      for (const gw of goalSet) {
        if (gw.length >= 4 && word.length >= 4) {
          if (gw.includes(word) || word.includes(gw)) {
            matched.push(word);
            break;
          }
        }
      }
    }
  }

  // Deduplicate
  const uniqueMatched = [...new Set(matched)];

  // Score: proportion of goal words that were matched
  const score = goalWords.length > 0 ? uniqueMatched.length / goalWords.length : 0;

  return { score, matched: uniqueMatched };
}
