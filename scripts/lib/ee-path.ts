/**
 * The one definition of an Activepieces Enterprise-licensed path: any `/ee/`
 * segment (`packages/ee/**`, `packages/server/api/src/app/ee/**`). Shared by
 * `scripts/check-no-ee-imports.ts` and the catalog license test so the two
 * cannot drift apart.
 */
export const EE_SEGMENT = /(^|\/)ee(\/|$)/;
