import { validateCronExpression, validateCronTimezone } from '../lib/cron-scheduler';
import type { FlowTriggerNode } from '../workflows/db/repos/flow-version';

export function workflowTriggerLabel(trigger?: FlowTriggerNode): string {
  if (!trigger) return 'Trigger unavailable';
  if (trigger.type === 'EMPTY') return 'Manual';
  const settings = trigger.settings, input = settings?.input ?? {};
  const piece = settings?.pieceName;
  if (piece === 'webhook' || piece === '@activepieces/piece-webhook') return 'Incoming webhook';
  if (piece === 'schedule' || piece === '@activepieces/piece-schedule') {
    const cron = input.cron_expression ?? input.cronExpression ?? input.expression;
    // Omitted timezone means Jarvis's configured one (readiness accepts it); a present one must be valid.
    const hasZone = Object.hasOwn(input, 'timezone'), zone = hasZone ? input.timezone : undefined;
    if (typeof cron !== 'string' || !cron.trim() || (piece !== 'schedule' && !hasZone)) return 'Schedule: setup required';
    try { validateCronExpression(cron); if (hasZone) validateCronTimezone(zone); } catch { return 'Schedule: setup required'; }
    const at = (time: string) => hasZone ? `${time} ${zone}` : time;
    const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
    const time = /^\d+$/.test(hour ?? '') && /^\d+$/.test(minute ?? '') ? `${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}` : null;
    if (time && month === '*') {
      if (day === '*' && weekday === '1-5') return `Weekdays at ${at(time)}`;
      if (day === '*' && weekday === '*') return `Daily at ${at(time)}`;
      if (day === 'LW' && weekday === '*') return `Last weekday of each month at ${at(time)}`;
    }
    if (time && day === '1-7' && month === '1,4,7,10' && weekday === '1') return `First Monday each quarter at ${at(time)}`;
    return hasZone ? `Schedule: ${cron.slice(0, 80)} (${zone})` : `Schedule: ${cron.slice(0, 80)}`;
  }
  return trigger.displayName?.trim().slice(0, 160) || 'Event trigger';
}
