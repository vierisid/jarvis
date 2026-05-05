/**
 * Tiny `{{step.path.to.value}}` resolver for piece input templating.
 *
 * Activepieces has a full variable resolver in
 * packages/server/engine/src/lib/variables/. Wiring that requires the engine
 * subprocess; until then we use a simple mustache-style replacement against a
 * step-output map, with these rules:
 *
 *   - `{{stepName}}`           -> stringified step output
 *   - `{{stepName.field}}`     -> nested property access (dot path)
 *   - `{{stepName.a.b.c}}`     -> deep nested
 *   - Standalone (whole value): if the entire string is a single `{{...}}`
 *     expression, the resolved object is substituted as-is (preserving type).
 *     Otherwise the resolved value is stringified and inlined.
 *   - Unknown step or missing field: throws `TemplateError` with the path.
 *
 * Numeric array indices are supported: `{{step1.items.0.title}}`.
 */

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

export type StepOutputs = Record<string, unknown>;

const TEMPLATE_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const WHOLE_TEMPLATE_RE = /^\s*\{\{\s*([^{}\s]+)\s*\}\}\s*$/;

/**
 * Resolve a single value. Strings get template substitution; objects/arrays
 * are walked recursively; primitives pass through.
 */
export function resolveTemplate(input: unknown, outputs: StepOutputs): unknown {
  if (typeof input === "string") return resolveString(input, outputs);
  if (Array.isArray(input)) return input.map((v) => resolveTemplate(v, outputs));
  if (input !== null && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      result[k] = resolveTemplate(v, outputs);
    }
    return result;
  }
  return input;
}

function resolveString(s: string, outputs: StepOutputs): unknown {
  // If the whole string is one expression, return the value as-is (keep type).
  const whole = WHOLE_TEMPLATE_RE.exec(s);
  if (whole) {
    const path = whole[1];
    if (typeof path !== "string") {
      throw new TemplateError(`malformed template in "${s}"`);
    }
    return resolvePath(path, outputs);
  }
  // Otherwise inline-replace each {{...}} with a stringified value.
  return s.replace(TEMPLATE_RE, (_match, path: string) => {
    const value = resolvePath(path, outputs);
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

function resolvePath(path: string, outputs: StepOutputs): unknown {
  const parts = path.split(".");
  if (parts.length === 0 || typeof parts[0] !== "string" || parts[0].length === 0) {
    throw new TemplateError(`empty template path: "${path}"`);
  }
  const head = parts[0];
  if (!(head in outputs)) {
    throw new TemplateError(`unknown step "${head}" referenced in template "${path}"`);
  }
  let cursor: unknown = outputs[head];
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i];
    if (typeof key !== "string") {
      throw new TemplateError(`malformed path "${path}"`);
    }
    if (cursor === null || cursor === undefined) {
      throw new TemplateError(`null/undefined while resolving "${path}" at "${key}"`);
    }
    if (Array.isArray(cursor)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        throw new TemplateError(`array index out of range in "${path}" at "${key}"`);
      }
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      const obj = cursor as Record<string, unknown>;
      if (!(key in obj)) {
        throw new TemplateError(`missing field "${key}" while resolving "${path}"`);
      }
      cursor = obj[key];
    } else {
      throw new TemplateError(`cannot descend into ${typeof cursor} while resolving "${path}"`);
    }
  }
  return cursor;
}
