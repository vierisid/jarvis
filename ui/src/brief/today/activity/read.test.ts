import { expect, test } from "bun:test";
import { recentRunsSource, RECENT_RUNS_URL } from "./read";

const signal = () => new AbortController().signal;
test("one bounded request, identity/status/time only", async () => {
  const urls: string[] = [];
  const read = await recentRunsSource(async url => { urls.push(url); return { items: [{ id: "r", flowId: "f", flowVersionId: "v", displayName: "Brief", status: "FAILED", startTime: 5, created: 4, steps: { x: "CANARY" } }] }; }).read(signal());
  expect(urls).toEqual([RECENT_RUNS_URL]);
  expect(read.data).toEqual([{ flowId: "f", versionId: "v", runId: "r", name: "Brief", status: "FAILED", result: "", at: 5, environment: "PRODUCTION" }]);
  expect(JSON.stringify(read)).not.toContain("CANARY");
});
test("empty page is empty; malformed rows are a failure, not an empty list", async () => {
  expect((await recentRunsSource(async () => ({ items: [] })).read(signal())).empty).toBe(true);
  await expect(recentRunsSource(async () => ({ items: [{ id: "r" }] })).read(signal())).rejects.toThrow();
  await expect(recentRunsSource(async () => []).read(signal())).rejects.toThrow();
});
test("a paused run keeps who it waits on and its resume time, nothing else", async () => {
  const read = await recentRunsSource(async () => ({ items: [
    { id: "a", flowId: "f", flowVersionId: "v", displayName: "A", status: "PAUSED", startTime: 5, waitingOn: "timer", resumeAt: 99 },
    { id: "b", flowId: "g", flowVersionId: "v", displayName: "B", status: "PAUSED", startTime: 4, waitingOn: "person" }] })).read(signal());
  expect(read.data?.map(r => [r.waitingOn, r.resumeAt])).toEqual([["timer", 99], ["person", undefined]]);
});
test("the name is cleaned and capped as on a card, and an empty one falls back to the flow id", async () => {
  const read = await recentRunsSource(async () => ({ items: [
    { id: "a", flowId: "f", flowVersionId: "v", displayName: "Invoice\u202Etxt.exe  sender\u200B", status: "SUCCEEDED", startTime: 5 },
    { id: "b", flowId: "g", flowVersionId: "v", displayName: "x".repeat(200), status: "SUCCEEDED", startTime: 4 },
    { id: "c", flowId: "h", flowVersionId: "v", displayName: "\u200B", status: "SUCCEEDED", startTime: 3 }] })).read(signal());
  expect(read.data?.map(r => r.name)).toEqual(["Invoicetxt.exe sender", `${"x".repeat(117)}...`, "h"]);
});
