import { expect, test } from 'bun:test';
import graph from './fixtures/daily-dst-generated.json';
import { validateScheduleFixtures } from './schedule-fixtures';
import { validateDurableScheduleFixtures } from './schedule-durable-fixtures';
test('actual saved daily graph passes all original DST and durable notification assertions',async()=>{
 const before=JSON.stringify(graph),report=await validateScheduleFixtures(graph,{suite:'dst_daily'});
 expect(report.passed).toBe(true);expect(report.cases).toHaveLength(11);expect(report.externalActions).toBe(0);
 expect(report.cases[2]).toMatchObject({scheduledOccurrences:0,notificationAttempts:0});
 expect(report.cases[3].occurrences).toEqual([{at:'2026-10-25T00:30:00.000Z',key:'2026-10-25T02:30'}]);
 expect(report.cases[5].notificationAttempts).toBe(0);
 expect(report.cases[6]).toMatchObject({notificationAttempts:1,confirmedDeliveries:1,duplicateAdmissions:4});
 expect(report.cases[8]).toMatchObject({notificationAttempts:2,confirmedDeliveries:0,statuses:['FAILED','FAILED','FAILED']});
 expect(report.cases[9]).toMatchObject({notificationAttempts:1,confirmedDeliveries:0,acceptedByMock:1});
 expect(report.cases[9].reviewItems.length).toBeGreaterThan(0);
 expect(report.cases[10]).toMatchObject({notificationAttempts:1,confirmedDeliveries:1});
 expect(JSON.stringify(graph)).toBe(before);
},60000);
test('suite refuses legacy DST policy and uncovered graph behaviors',async()=>{
 const bad=structuredClone(graph);delete (bad.settings.input as any).dst_policy;
 await expect(validateDurableScheduleFixtures(bad)).rejects.toThrow('explicit');
 (bad.settings.input as any).dst_policy='skip_missing_first_repeated';
 // A zone nobody chose is not used, and other zones are not covered: the error says what to use instead.
 const unchosen=structuredClone(graph);delete (unchosen.settings as any).chosenTimezone;
 await expect(validateDurableScheduleFixtures(unchosen)).rejects.toThrow('fixture_input.cases');
 const sydney=structuredClone(graph);sydney.settings.input.timezone='Australia/Sydney';(sydney.settings as any).chosenTimezone='Australia/Sydney';
 await expect(validateDurableScheduleFixtures(sydney)).rejects.toThrow('only a daily 02:30 schedule in a chosen Europe/Rome zone');(bad.nextAction as any).nextAction=graph.nextAction;
 await expect(validateDurableScheduleFixtures(bad)).rejects.toThrow('only schedule');
});
