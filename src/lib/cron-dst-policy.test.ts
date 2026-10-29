import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { CronScheduler } from './cron-scheduler';
let scheduler: CronScheduler | undefined;
afterEach(()=>{scheduler?.cancelAll();setSystemTime();});
const policy = 'skip_missing_first_repeated' as const;
test('explicit DST policy skips spring gap rather than shifting to 03:00',()=>{
 setSystemTime(new Date('2026-03-29T00:58:00Z'));scheduler=new CronScheduler();const fired:any[]=[];
 scheduler.schedule('daily','30 2 * * *',o=>fired.push(o),{timezone:'Europe/Rome',dstPolicy:policy} as any);
 for(let t=Date.parse('2026-03-29T00:59:00Z');t<=Date.parse('2026-03-29T01:32:00Z');t+=60000)scheduler.runDue('daily',t);
 expect(fired).toHaveLength(0);
});
test('second autumn occurrence is excluded even when process starts after first',()=>{
 setSystemTime(new Date('2026-10-25T01:29:00Z'));scheduler=new CronScheduler();const fired:any[]=[];
 scheduler.schedule('daily','30 2 * * *',o=>fired.push(o),{timezone:'Europe/Rome',dstPolicy:policy} as any);
 scheduler.runDue('daily',Date.parse('2026-10-25T01:30:00Z'));expect(fired).toHaveLength(0);
});

test('strict matcher and next occurrence agree on both autumn instants',()=>{
 expect(CronScheduler.matchesIn('30 2 * * *',new Date('2026-10-25T00:30:00Z'),'Europe/Rome',policy)).toBe(true);
 expect(CronScheduler.matchesIn('30 2 * * *',new Date('2026-10-25T01:30:00Z'),'Europe/Rome',policy)).toBe(false);
 expect(CronScheduler.nextRun('30 2 * * *',new Date('2026-10-25T00:30:00Z'),undefined,'Europe/Rome',policy)?.toISOString()).toBe('2026-10-26T01:30:00.000Z');
 expect(CronScheduler.occurrencesBetween('30 2 * * *',Date.parse('2026-10-25T00:29:00Z'),Date.parse('2026-10-25T01:31:00Z'),100,'Europe/Rome',policy)).toHaveLength(1);
});
test('half-hour fold also excludes only the later local occurrence',()=>{
 expect(CronScheduler.matchesIn('45 1 * * *',new Date('2026-04-04T14:45:00Z'),'Australia/Lord_Howe',policy)).toBe(true);
 expect(CronScheduler.matchesIn('45 1 * * *',new Date('2026-04-04T15:15:00Z'),'Australia/Lord_Howe',policy)).toBe(false);
});
test('invalid policy is refused rather than silently ignored',()=>{
 scheduler=new CronScheduler();expect(()=>scheduler!.schedule('bad','30 2 * * *',()=>{},{timezone:'Europe/Rome',dstPolicy:'invented'} as any)).toThrow('DST policy');
});
