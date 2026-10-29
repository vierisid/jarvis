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
 expect(report.cases[9]).toMatchObject({notificationAttempts:1,confirmedDeliveries:0,acceptedByMock:1});
 expect(report.cases[9].reviewItems.length).toBeGreaterThan(0);
 expect(report.cases[10]).toMatchObject({notificationAttempts:1,confirmedDeliveries:1});
 expect(JSON.stringify(graph)).toBe(before);
},60000);
test('suite refuses legacy DST policy and uncovered graph behaviors',async()=>{
 const bad=structuredClone(graph);delete (bad.settings.input as any).dst_policy;
 await expect(validateDurableScheduleFixtures(bad)).rejects.toThrow('explicit');
 (bad.settings.input as any).dst_policy='skip_missing_first_repeated';(bad.nextAction as any).nextAction=graph.nextAction;
 await expect(validateDurableScheduleFixtures(bad)).rejects.toThrow('only schedule');
});
