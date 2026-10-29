import {afterEach,expect,setSystemTime,test} from 'bun:test';
import {CronScheduler,setCronTimezone,validateCronExpression} from './cron-scheduler';

afterEach(()=>{setSystemTime();setCronTimezone(null);});
const expression='0 17 LW * *';
const cases=[
 ['2023-02-01T00:00:00Z','2023-02-28T16:00:00.000Z'],
 ['2024-02-01T00:00:00Z','2024-02-29T16:00:00.000Z'],
 ['2024-08-01T00:00:00Z','2024-08-30T15:00:00.000Z'],
 ['2024-03-01T00:00:00Z','2024-03-29T16:00:00.000Z'],
 ['2026-02-01T00:00:00Z','2026-02-27T16:00:00.000Z'],
 ['2027-02-01T00:00:00Z','2027-02-26T16:00:00.000Z'],
 ['2026-07-01T00:00:00Z','2026-07-31T15:00:00.000Z'],
 ['2026-10-01T00:00:00Z','2026-10-30T16:00:00.000Z'],
 ['2026-12-01T00:00:00Z','2026-12-31T16:00:00.000Z'],
];
for(const [from,expected] of cases) test('LW in Rome: '+expected,()=>{
 expect(()=>validateCronExpression(expression)).not.toThrow();
 expect(CronScheduler.nextRun(expression,new Date(from!),undefined,'Europe/Rome')?.toISOString()).toBe(expected);
 expect(CronScheduler.matchesIn(expression,new Date(expected!),'Europe/Rome')).toBe(true);
});
test('exactly one occurrence each month across 96 calendar months',()=>{
 for(let year=2023;year<=2030;year++)for(let month=0;month<12;month++){
  const start=Date.UTC(year,month,1),end=Date.UTC(year,month+1,1);
  const hits=CronScheduler.occurrencesBetween(expression,start,end,100,'Europe/Rome');
  const last=new Date(end-86400000);while([0,6].includes(last.getUTCDay()))last.setUTCDate(last.getUTCDate()-1);
  expect(hits.map(h=>h.key)).toEqual([last.toISOString().slice(0,10)+'T17:00']);
 }
});
test('local-zone matcher and nextRun use the same last weekday rule',()=>{
 setCronTimezone(null);
 const from=new Date(2027,1,1),expected=new Date(2027,1,26,17);
 expect(CronScheduler.nextRun(expression,from)?.getTime()).toBe(expected.getTime());
 expect(CronScheduler.matches(expression,expected)).toBe(true);
 expect(CronScheduler.matches(expression,new Date(2027,1,27,17))).toBe(false);
});
test('explicit zone wins over process default and respects month restrictions',()=>{
 setCronTimezone('America/Los_Angeles');
 expect(CronScheduler.nextRun('0 17 LW 2 *',new Date('2026-12-31T16:00:00Z'),undefined,'Europe/Rome')?.toISOString()).toBe('2027-02-26T16:00:00.000Z');
 expect(CronScheduler.matchesIn(expression,new Date('2027-02-26T16:00:00Z'),'America/Los_Angeles')).toBe(false);
});
for(const invalid of ['0 LW * * *','LW 17 * * *','0 17 LW/2 * *','0 17 LW,15 * *','0 17 L * *','0 17 31W * *','0 17 * LW *','0 17 * * LW'])test('reject unsupported syntax '+invalid,()=>{
 expect(()=>validateCronExpression(invalid)).toThrow();
});
test('repeated ticks and a clock correction start only the actual last weekday',()=>{
 setSystemTime(new Date('2027-02-25T15:59:00Z'));const scheduler=new CronScheduler();const keys:string[]=[];
 try {
  scheduler.schedule('monthly',expression,o=>keys.push(o.key),{timezone:'Europe/Rome'});
  for(const at of ['2027-02-25T16:00:10Z','2027-02-26T16:00:10Z','2027-02-26T16:01:10Z','2027-02-26T15:50:00Z','2027-02-26T16:00:20Z','2027-02-27T16:00:00Z','2027-02-28T16:00:00Z'])scheduler.runDue('monthly',Date.parse(at));
  expect(keys).toEqual(['2027-02-26T17:00']);
 }finally{scheduler.cancelAll();}
});
