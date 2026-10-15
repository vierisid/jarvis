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
 * The dependencies a CODE step's `package.json` declares, validated. Throws,
 * naming the step, on anything that is not a plain registry dependency.
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
