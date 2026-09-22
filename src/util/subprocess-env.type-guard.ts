/**
 * Type-level regression fixture for sanitizedEnv()'s `extra` parameter.
 *
 * This file contains no runtime behaviour. It exists so that `bunx tsc
 * --noEmit` fails if the compile-time guard on `extra` erodes -- which it can,
 * silently, because part of what makes the guard bite comes from AMBIENT types
 * rather than from this repo: the spread form is rejected only because
 * `ProcessEnv` happens to declare a named `TZ?: string` outside ExtraEnvKey. A
 * bun-types or @types/node bump that drops `TZ` would quietly reopen the exact
 * shape the module's doc comment is written about.
 *
 * `@ts-expect-error` is the right instrument because it fails in BOTH
 * directions: the build breaks if the call stops erroring (the guard eroded)
 * and also if the call never errored in the first place (the fixture is
 * stale). A plain negative test could only catch one of those.
 *
 * The runtime EXTRA_ENV_KEY_SET check in filterEnv is the actual guarantee and
 * is covered by subprocess-env.test.ts. This file guards the early-feedback
 * layer only.
 */
import { sanitizedEnv } from './subprocess-env.ts';

// -- Must NOT compile ------------------------------------------------------

// The mechanical-refactor shape: the code this module replaced was
// `env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }`, so this is the cheapest
// possible edit and must never be allowed to look sanitized.
// @ts-expect-error - spreading the daemon environment into `extra`
export const spreadProcessEnv = sanitizedEnv({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

// A plain unknown key.
// @ts-expect-error - TOTALLY_MADE_UP_KEY is not an ExtraEnvKey
export const unknownKey = sanitizedEnv({ TOTALLY_MADE_UP_KEY: 'x' });

// An arbitrary string-keyed record.
declare const record: Record<string, string>;
// @ts-expect-error - an open record is not a closed set of extras
export const openRecord = sanitizedEnv(record);

// A credential-shaped key, rejected at the type level as well as at runtime.
// @ts-expect-error - NPM_TOKEN is not an ExtraEnvKey
export const credentialKey = sanitizedEnv({ NPM_TOKEN: 'sentinel-do-not-log' });

// -- Must compile ----------------------------------------------------------

export const noExtras = sanitizedEnv();
export const gitPrompt = sanitizedEnv({ GIT_TERMINAL_PROMPT: '0' });
export const devServer = sanitizedEnv({ PORT: '3000', HOST: '127.0.0.1', NODE_ENV: 'development' });
export const undefinedValue = sanitizedEnv({ PORT: undefined });
