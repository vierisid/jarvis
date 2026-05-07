/**
 * Branch condition evaluator for ROUTER nodes.
 *
 * Mirrors a useful subset of activepieces' `BranchOperator` enum. Date
 * operators are deliberately omitted for now -- when the first flow needs
 * them we'll plumb them through; until then their absence is preferable to
 * shipping half-baked timezone semantics.
 *
 * Conditions are 2D: outer array = OR, inner array = AND. So
 * `[[c1, c2], [c3]]` means `(c1 AND c2) OR c3`. Empty outer array = false
 * (a CONDITION branch with no conditions never matches; FALLBACK branches
 * are handled by the router itself, not here).
 */

import { resolveTemplate, TemplateError, type StepOutputs } from "./templating";

export interface BranchCondition {
  firstValue: string;
  operator: string;
  secondValue?: string;
  caseSensitive?: boolean;
}

export type BranchConditionGroups = ReadonlyArray<ReadonlyArray<BranchCondition>>;

/** Returns true when at least one AND-group is fully satisfied. */
export function evaluateConditionGroups(
  groups: BranchConditionGroups,
  outputs: StepOutputs,
): boolean {
  if (!groups || groups.length === 0) return false;
  for (const andGroup of groups) {
    if (andGroup.length === 0) continue;
    let all = true;
    for (const cond of andGroup) {
      if (!evaluateCondition(cond, outputs)) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/** Single-condition evaluation. Throws nothing -- malformed templates are treated as false. */
export function evaluateCondition(c: BranchCondition, outputs: StepOutputs): boolean {
  let left: unknown;
  let right: unknown;
  try {
    left = resolveTemplate(c.firstValue, outputs);
  } catch (e) {
    if (e instanceof TemplateError) return false;
    throw e;
  }
  try {
    right = c.secondValue !== undefined ? resolveTemplate(c.secondValue, outputs) : undefined;
  } catch (e) {
    if (e instanceof TemplateError) return false;
    throw e;
  }

  const cs = c.caseSensitive === true;
  const sLeft = cs ? toStr(left) : toStr(left).toLowerCase();
  const sRight = cs ? toStr(right) : toStr(right).toLowerCase();

  switch (c.operator) {
    case "TEXT_CONTAINS": return sLeft.includes(sRight);
    case "TEXT_DOES_NOT_CONTAIN": return !sLeft.includes(sRight);
    case "TEXT_EXACTLY_MATCHES": return sLeft === sRight;
    case "TEXT_DOES_NOT_EXACTLY_MATCH": return sLeft !== sRight;
    case "TEXT_START_WITH": return sLeft.startsWith(sRight);
    case "TEXT_DOES_NOT_START_WITH": return !sLeft.startsWith(sRight);
    case "TEXT_ENDS_WITH": return sLeft.endsWith(sRight);
    case "TEXT_DOES_NOT_END_WITH": return !sLeft.endsWith(sRight);

    case "NUMBER_IS_GREATER_THAN": return finiteNum(left) > finiteNum(right);
    case "NUMBER_IS_LESS_THAN": return finiteNum(left) < finiteNum(right);
    case "NUMBER_IS_EQUAL_TO": return finiteNum(left) === finiteNum(right);

    case "BOOLEAN_IS_TRUE": return toBool(left) === true;
    case "BOOLEAN_IS_FALSE": return toBool(left) === false;

    case "EXISTS": return left !== undefined && left !== null && left !== "";
    case "DOES_NOT_EXIST": return left === undefined || left === null || left === "";

    case "LIST_IS_EMPTY": return Array.isArray(left) && left.length === 0;
    case "LIST_IS_NOT_EMPTY": return Array.isArray(left) && left.length > 0;
    case "LIST_CONTAINS": return Array.isArray(left) && left.some((v) => loose(v) === loose(right));
    case "LIST_DOES_NOT_CONTAIN":
      return !Array.isArray(left) || !left.some((v) => loose(v) === loose(right));

    default:
      // Unknown operator: behave as false. Safer than throwing because
      // a single unsupported branch shouldn't kill the whole router run.
      return false;
  }
}

function toStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function finiteNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no" || s === "") return false;
  }
  return Boolean(v);
}

/** Loose equality used by LIST_CONTAINS: stringify primitives for comparison. */
function loose(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
