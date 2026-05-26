/**
 * Compatibility shim. The CronScheduler implementation now lives at
 * `src/lib/cron-scheduler.ts` so it can be reused by the system-cron service
 * outside the workflow runtime. This file re-exports the public surface used
 * by workflow trigger code and tests.
 *
 * Prefer importing from `src/lib/cron-scheduler` in new code.
 */
export {
  CronScheduler,
  parseEveryExpression,
  type CronJob,
  type CronJobInfo,
} from '../../../lib/cron-scheduler.ts';
