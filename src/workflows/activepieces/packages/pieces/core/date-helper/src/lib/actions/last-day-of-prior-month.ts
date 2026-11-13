import { Property, createAction } from '@activepieces/pieces-framework';
import {
  optionalTimeFormats,
  timeFormat,
  timeFormatDescription,
  timeZoneOptions,
  getCorrectedFormat,
  apDayjs,
} from '../common';
import { z } from 'zod';
import { propsValidation } from '@activepieces/pieces-common';

export const lastDayOfPreviousMonthAction = createAction({
  name: 'last_day_of_previous_month',
  displayName: 'Last Day of Previous Month',
  description: 'Get the date and time of the last day of the previous month',
  errorHandlingOptions: {
    continueOnFailure: {
      hide: true,
    },
    retryOnFailure: {
      hide: true,
    },
  },
  props: {
    time: Property.ShortText({
      displayName: '24h Time',
      description:
        'The time that you would like to get the date and time of, as HH:mm in 24h format, for example 09:30. Not used when "Use Current Time" is checked.',
      required: false,
      defaultValue: '00:00',
    }),
    currentTime: Property.Checkbox({
      displayName: 'Use Current Time',
      description:
        'If checked, the current time will be used instead of the time specified above.',
      required: false,
      defaultValue: false,
    }),
    timeFormat: Property.StaticDropdown({
      displayName: 'To Time Format',
      description: timeFormatDescription,
      options: {
        options: optionalTimeFormats,
      },
      required: true,
      defaultValue: timeFormat.format00,
    }),
    timeZone: Property.StaticDropdown<string>({
      displayName: 'Time Zone',
      options: {
        options: timeZoneOptions,
      },
      required: true,
      defaultValue: 'UTC',
    }),
  },
  async run(context) {
    // === JARVIS PATCH: "Use Current Time" does not need a time to be given ===
    await propsValidation.validateZod(context.propsValue, {
      ...(context.propsValue.currentTime === true ? {} : { time: z.string().regex(/^\d\d:\d\d$/) }),
    });
    // === END JARVIS PATCH ===

    const outputTimeFormat = getCorrectedFormat(context.propsValue.timeFormat);
    const selectedTimeZone = context.propsValue.timeZone as string;
    const useCurrentTime = context.propsValue.currentTime as boolean;
    let providedTime = context.propsValue.time as string;

    const baseDateTime = apDayjs().tz(selectedTimeZone);

    if (useCurrentTime === true) {
      providedTime = `${baseDateTime.hour()}:${baseDateTime.minute()}`;
    }
    const [hours, minutes] = providedTime.split(':').map(Number);

    // Validate inputs
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error(`Invalid input \nhours: ${hours} \nminutes: ${minutes}`);
    }

    const lastDayOfPreviousMonth = baseDateTime
      .subtract(1, 'month')
      .endOf('month')
      .hour(hours)
      .minute(minutes)
      .second(0)
      .millisecond(0);

    return { result: lastDayOfPreviousMonth.format(outputTimeFormat) };
  },
});
