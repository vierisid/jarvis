/**
 * What a CODE step's package.json may declare (#837): validation only, with no
 * Node imports, so both the daemon's materializer (code-materialize.ts) and
 * readiness (workflow-readiness.ts, which reports a refused manifest when the
 * flow is saved rather than when it runs) share one rule.
 */

/** An npm package name, scoped or not. No path segments beyond the scope. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/** One semver comparator: `1`, `^1.2`, `>=1.2.3-rc.1`, `~1.x`, `*`. */
const COMPARATOR = /^(?:\^|~|[<>]=?|=)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A dist-tag: `latest`, `next`, `beta-2`. No dots, so never a file name. */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * A registry spec, positively: a dist-tag, or a range built from semver
 * comparators joined by spaces, `||` or a ` - ` hyphen range. Everything else
 * is refused, and that is what keeps non-registry sources out: `file:`,
 * `link:`, `workspace:`, `npm:` aliases, git and URL specs and GitHub's
 * `user/repo` all need a `:` or `/`; and the shapes Bun reads as a local
 * folder or tarball without either -- `.`, `..`, `x.tgz`, `x.tar.gz` (found in
 * review: an allowlist of characters let them through, and `bun install`
 * installed both) -- are refused by name, including as a prerelease tag.
 */
export function isRegistrySpec(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("~/") || /\.(?:tgz|tar|tar\.gz)$/iu.test(spec)) return false;
  if (DIST_TAG.test(spec)) return true;
  const tokens = spec.split(/\s+/u);
  return tokens.some((t) => COMPARATOR.test(t)) && tokens.every((t) => t === "||" || t === "-" || COMPARATOR.test(t));
}

/**
 * Most packages one CODE step may declare (#865). What costs disk is the
 * installed size, which only the install can measure, so that has its own cap
 * (CODE_STEP_MAX_INSTALL_BYTES in code-materialize.ts); this one is checked by
 * readiness, so a list that would all but certainly blow through it is
 * reported on the step when the flow is saved and refused at publish, enable
 * and run, before anything is installed. Measured with bun 1.3.8, `--ignore-scripts
 * --linker=hoisted`, apparent size: the median single popular package
 * installs to 16.5 MiB (19 measured, from pg at 0.4 MiB to googleapis at
 * 246.5 MiB), and 512 MiB / 16.5 MiB is 31.
 */
export const CODE_STEP_MAX_DEPENDENCIES = 32;

/**
 * The dependencies a CODE step's `package.json` declares, validated. Throws,
 * naming the step, on anything that is not a plain registry dependency, and on
 * more than CODE_STEP_MAX_DEPENDENCIES of them.
 */
export function declaredDependencies(stepName: string, packageJson: string): Record<string, string> {
  const text = packageJson.trim();
  if (text === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`CODE step "${stepName}": its package.json is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`CODE step "${stepName}": its package.json must be a JSON object`);
  }
  const deps = (parsed as Record<string, unknown>)["dependencies"];
  if (deps === undefined) return {};
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    throw new Error(`CODE step "${stepName}": "dependencies" in its package.json must be an object`);
  }
  const declared = Object.keys(deps as Record<string, unknown>).length;
  if (declared > CODE_STEP_MAX_DEPENDENCIES) {
    throw new Error(
      `CODE step "${stepName}": its package.json declares ${declared} dependencies; ` +
        `a CODE step may declare at most ${CODE_STEP_MAX_DEPENDENCIES}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(deps as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!PACKAGE_NAME.test(name)) {
      throw new Error(`CODE step "${stepName}": ${JSON.stringify(name)} is not a package name`);
    }
    if (typeof spec !== "string" || !isRegistrySpec(spec.trim())) {
      throw new Error(
        `CODE step "${stepName}": dependency ${JSON.stringify(name)} must be a registry version, range or tag, ` +
          `not ${JSON.stringify(spec)} (file, folder, tarball, link, git, URL and alias specs are refused)`,
      );
    }
    out[name] = spec.trim();
  }
  return out;
}
