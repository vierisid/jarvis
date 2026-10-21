/** Suggestions use only canonical, visible interview facts. No inferred apps or schedules. */
export interface InterviewFact { theme: string; summary: string }
export interface ActivationSuggestion { id: string; label: string; prompt: string }
export interface InterviewSuggestions { goal?: string; suggestions: ActivationSuggestion[] }
export function interviewSuggestions(facts: InterviewFact[]): InterviewSuggestions {
  const clean = facts.map(f => ({ theme: f.theme.toLowerCase(), summary: f.summary.trim() })).filter(f => f.summary);
  const goal = clean.filter(f => f.theme === 'goals').at(-1)?.summary;
  const routines = [...new Set(clean.filter(f => f.theme === 'rhythm').map(f => f.summary))].slice(-3);
  const starters = routines.length ? routines : goal ? [goal] : [];
  const suggestions = starters.flatMap((summary, i) => {
    const lines = [routines.length ? `Help me with this routine: ${summary}` : `Help me plan the next step toward this goal: ${summary}`];
    if (goal && routines.length) lines.push(`My goal: ${goal}`);
    lines.push('Prepare a draft for me to review. Do not send, publish or change anything without my approval.');
    for (const fact of clean.filter(f => f.theme === 'scope')) lines.push(`My preferences: ${fact.summary}`);
    if (lines.join('\n\n').length > 2000) return [];
    // Include complete facts, prioritizing the user's boundaries. Never cut a sentence in half.
    for (const theme of ['tools', 'work', 'projects']) {
      for (const fact of clean.filter(f => f.theme === theme).slice(-3)) {
        const line = `Interview context: ${fact.summary}`;
        if ([...lines, line].join('\n\n').length <= 2000) lines.push(line);
      }
    }
    return [{ id: `interview-${i}`, label: summary, prompt: lines.join('\n\n') }];
  });
  return { goal, suggestions };
}
