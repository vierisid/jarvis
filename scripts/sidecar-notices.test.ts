/**
 * #1166: the sidecar binary statically links Go modules whose licenses (BSD,
 * MIT, ISC, Apache) ask for their notices with any binary distribution.
 * THIRD_PARTY_NOTICES.md lists each one with its license text; this holds that
 * list to what sidecar/go.mod requires, so a new or bumped module cannot go in
 * without its license being reviewed there. (Shipping that text inside the
 * release artifacts is not done yet.)
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** `module version` for every require directive, single-line and block form. */
function goModRequires(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (inBlock) {
      if (line === ")") { inBlock = false; continue; }
      const [mod, ver] = line.split(/\s+/);
      if (mod && ver) out.push(`${mod} ${ver}`);
    } else if (/^require\s*\($/.test(line)) {
      inBlock = true;
    } else {
      const m = /^require\s+(\S+)\s+(\S+)$/.exec(line);
      if (m) out.push(`${m[1]} ${m[2]}`);
    }
  }
  return out.sort();
}

function sidecarSection(text: string): string {
  const start = text.indexOf("## Sidecar (Go modules)");
  return start < 0 ? "" : text.slice(start).split(/\n## /)[0]!;
}

/** `module version` for every row of the notices' sidecar module table. */
function noticedModules(text: string): string[] {
  return [...sidecarSection(text).matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
}

/**
 * Each `### ` subsection of the sidecar section, keyed by its heading. Headings
 * inside a fenced license text (yaml.v3's has `### Apache License ###`) are text.
 */
function subsections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  let fenced = false;
  const flush = () => { if (heading !== null) out.set(heading, body.join("\n")); };
  for (const line of sidecarSection(text).split("\n")) {
    if (line === "```") fenced = !fenced;
    if (!fenced && line.startsWith("### ")) {
      flush();
      heading = line.slice(4);
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();
  return out;
}

describe("sidecar Go module notices", () => {
  test("THIRD_PARTY_NOTICES.md lists exactly the modules sidecar/go.mod requires, at those versions", () => {
    const required = goModRequires(readFileSync(resolve(ROOT, "sidecar/go.mod"), "utf8"));
    const notices = readFileSync(resolve(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(required.length).toBeGreaterThan(0);
    expect(noticedModules(notices)).toEqual(required);
    // Every listed module, and the standard library, has its own section with a license text.
    const sections = subsections(notices);
    for (const heading of [...required, "Go standard library and runtime"]) {
      expect(sections.get(heading) ?? "").toMatch(/\n```\n[^`]{200,}\n```/);
    }
    // Nothing else: a stray heading would mean a module the table does not list.
    expect([...sections.keys()].sort()).toEqual([...required, "Go standard library and runtime"].sort());
  });

  test("the vendored webview_go license texts are reproduced byte for byte", () => {
    // A replace directive points go.mod at the vendored copy, so re-vendoring it
    // does not move the version above: compare its files directly.
    const section = subsections(readFileSync(resolve(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8"))
      .get("github.com/webview/webview_go v0.0.0-20240831120633-6173450d4dd6") ?? "";
    for (const file of ["LICENSE", "libs/webview/LICENSE", "libs/mswebview2/LICENSE"]) {
      const text = readFileSync(resolve(ROOT, "sidecar/third_party/webview_go", file), "utf8").replace(/\s+$/, "");
      expect(section).toContain(`${file}:\n\n\`\`\`\n${text}\n\`\`\``);
    }
  });

  test("the go.mod reader takes block and single-line requires and ignores comments", () => {
    const text = [
      "module x", "", "go 1.25.0", "",
      "require a.example/one v1.0.0 // indirect",
      "require (", "\tb.example/two v0.2.0", "\t// c.example/commented v9.9.9", "\td.example/three v3.0.0 // indirect", ")",
      "replace b.example/two => ./two",
    ].join("\n");
    expect(goModRequires(text)).toEqual(["a.example/one v1.0.0", "b.example/two v0.2.0", "d.example/three v3.0.0"]);
  });
});
