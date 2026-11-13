import {
  createAction,
  Property,
} from '@activepieces/pieces-framework';
import { ExecutionType } from '@activepieces/shared';
import { markdownDescription } from '../common';
import { z } from 'zod';
import { propsValidation } from '@activepieces/pieces-common';

enum TimeUnit {
  SECONDS = 'seconds',
  MINUTES = 'minutes',
  HOURS = 'hours',
  DAYS = 'days',
}

export const delayForAction = createAction({
  name: 'delayFor',
  displayName: 'Delay For',
  description: 'Delays the execution of the next action for a given duration',
  errorHandlingOptions: {
    continueOnFailure: {
      hide: true,
    },
    retryOnFailure: {
      hide: true,
    },
  },
  props: {
    markdown: Property.MarkDown({
      value: markdownDescription,
    }),
    unit: Property.StaticDropdown({
      displayName: 'Unit',
      description: 'The unit of time to delay the execution of the next action',
      required: true,
      options: {
        options: [
          { value: TimeUnit.SECONDS, label: 'Seconds' },
          { value: TimeUnit.MINUTES, label: 'Minutes' },
          { value: TimeUnit.HOURS, label: 'Hours' },
          { value: TimeUnit.DAYS, label: 'Days' },
        ],
      },
      defaultValue: TimeUnit.SECONDS,
    }),
    delayFor: Property.Number({
      displayName: 'Amount',
      description:
        'The number of units to delay the execution of the next action',
      required: true,
    }),
  },
  async run(ctx) {
    // === JARVIS PATCH: an amount that is not a finite number is refused in plain words ===
    // Infinity passes `z.number().min(0)`, and an amount too large to hold in
    // milliseconds is Infinity after the unit conversion. Either one used to
    // reach the wait with no usable resume time. A negative amount used to fail
    // as zod JSON. The value itself is never echoed: it can come from run data.
    const amount = ctx.propsValue.delayFor;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new Error('The delay amount is not a usable number.');
    }
    if (amount < 0) {
      throw new Error('The delay amount cannot be negative.');
    }
    // === END JARVIS PATCH ===
    await propsValidation.validateZod(ctx.propsValue, {
      delayFor: z.number().min(0),
    });

    const unit = ctx.propsValue.unit ?? TimeUnit.SECONDS;
    const delayInMs = calculateDelayInMs(ctx.propsValue.delayFor, unit);
    // === JARVIS PATCH: see above; a finite amount can still overflow the conversion ===
    if (!Number.isFinite(delayInMs)) {
      throw new Error('The delay amount is too large. A run can wait at most 30 days.');
    }
    // === END JARVIS PATCH ===
    if (ctx.executionType == ExecutionType.RESUME) {
      return {
        delayForInMs: delayInMs,
        success: true,
      };
    } else if (delayInMs > 1 * 10 * 1000) {
      // use flow pause
      const currentTime = new Date();
      const futureTime = new Date(currentTime.getTime() + delayInMs);
      const waitpoint = await ctx.run.createWaitpoint({
        type: 'DELAY',
        resumeDateTime: futureTime.toUTCString(),
      });
      ctx.run.waitForWaitpoint(waitpoint.id);
      return {};
    } else {
      // use setTimeout
      await new Promise((resolve) => setTimeout(resolve, delayInMs));
      return {
        delayForInMs: delayInMs,
        success: true,
      };
    }
  },
  async test(ctx) {
    const unit = ctx.propsValue.unit ?? TimeUnit.SECONDS;
    return {
      delayForInMs: calculateDelayInMs(ctx.propsValue.delayFor, unit),
      success: true,
    };
  }
});

function calculateDelayInMs(amount: number, unit: TimeUnit): number {
  let delayInMs: number;
  switch (unit) {
    case TimeUnit.SECONDS:
      delayInMs = amount * 1000;
      break;
    case TimeUnit.MINUTES:
      delayInMs = amount * 60 * 1000;
      break;
    case TimeUnit.HOURS:
      delayInMs = amount * 60 * 60 * 1000;
      break;
    case TimeUnit.DAYS:
      delayInMs = amount * 24 * 60 * 60 * 1000;
      break;
  }
  return delayInMs;
}
