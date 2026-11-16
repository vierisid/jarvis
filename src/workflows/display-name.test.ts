import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeWorkflowDb, initWorkflowDb } from "./db";
import { createFlow } from "./db/repos/flow";
import { createDraftVersion, updateDraftVersion } from "./db/repos/flow-version";
import { displayWorkflowName, isBlankWorkflowName, workflowNameProblem } from "./display-name";

beforeEach(() => initWorkflowDb(":memory:"));
afterEach(() => closeWorkflowDb());

test("a name with nothing visible is blank, any visible character is not", () => {
  for (const blank of ["", "   ", "\t\n", "​‍", "‮", "﻿", " 　", "\ud800"])
    expect(isBlankWorkflowName(blank)).toBe(true);
  for (const name of ["a", "a​b", "שלום", "\u{1f600}"])
    expect(isBlankWorkflowName(name)).toBe(false);
  expect(workflowNameProblem("  Digest  ")).toEqual({ ok: true, name: "Digest" });
  expect(workflowNameProblem(" ​ ")).toEqual({ ok: false, problem: "blank" });
  expect(workflowNameProblem(3)).toEqual({ ok: false, problem: "blank" });
  expect(workflowNameProblem("abc", 2)).toEqual({ ok: false, problem: "too_long", length: 3, max: 2 });
  expect(displayWorkflowName("  ")).toBe("Untitled workflow");
  expect(displayWorkflowName(undefined)).toBe("Untitled workflow");
  expect(displayWorkflowName("Digest")).toBe("Digest");
});

test("no internal writer stores a blank name: the composer and tool fallbacks become Untitled workflow", () => {
  const flow = createFlow({});
  const version = createDraftVersion({ flowId: flow.id, displayName: "  ​ ", trigger: { name: "trigger", type: "EMPTY", displayName: "Manual" } });
  expect(version.displayName).toBe("Untitled workflow");
  expect(updateDraftVersion(version.id, { displayName: "\u0000" }).displayName).toBe("Untitled workflow");
  expect(updateDraftVersion(version.id, { displayName: "Kept" }).displayName).toBe("Kept");
});
