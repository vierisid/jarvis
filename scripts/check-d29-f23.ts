/** Optional cross-stack proof. Run only against the reviewed, pinned F-23 worktree.
 * Every provider read/write uses a fresh temporary vault and secrets directory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createProfilePort } from "../ui/src/brief/account/profile/adapter";
import { ProfileController } from "../ui/src/brief/account/profile/controller";
const root = process.env.D29_F23_ROOT;
if (!root) throw Error("Set D29_F23_ROOT to the pinned F-23 checkout");
const pin = "13beb76554514227e0fb2fa476e7cd78f5432053";
// Hooks export worktree metadata: -C alone would accidentally verify the D checkout.
const pinEnv = { ...process.env };
for (const key of Object.keys(pinEnv))
  if (key.startsWith("GIT_")) delete pinEnv[key];
assert.equal(
  Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { env: pinEnv })
    .stdout.toString()
    .trim(),
  pin,
);
assert.equal(
  Bun.spawnSync(
    ["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
    { env: pinEnv },
  )
    .stdout.toString()
    .trim(),
  "",
);
const load = (path: string): Promise<any> =>
  import(pathToFileURL(resolve(root, path)).href);
const dir = mkdtempSync(join(tmpdir(), "d29-f23-"));
process.env.JARVIS_SECRETS_DIR = join(dir, "secrets");
process.env.JARVIS_BRIEF_PROFILE_SETTINGS = "1";
const { initDatabase, closeDb, getDb } = await load("src/vault/schema.ts");
const { saveUserProfile, appendUserProfileFact, getUserProfile } = await load(
  "src/vault/user-profile.ts",
);
const { findFacts } = await load("src/vault/facts.ts");
const { ProfileSettings } = await load("src/brief/profile-settings.ts");
const { createProfileSettingsRoutes } = await load(
  "src/brief/profile-settings-routes.ts",
);
const { BriefCapabilities } = await load("src/brief/capabilities.ts");
const { DEFAULT_CONFIG } = await load("src/config/types.ts");
const file = join(dir, "vault.db");
let controller: ProfileController | undefined;
let writes = 0,
  loseReply = false;
try {
  initDatabase(file, { quiet: true });
  saveUserProfile({
    preferred_name: "Alex",
    interests: "Space",
    work_role: "Founder\nDesigner",
  });
  appendUserProfileFact({ theme: "work", summary: "Morning focus" });
  let service: any, routes: any;
  const connect = () => {
    service = new ProfileSettings(structuredClone(DEFAULT_CONFIG));
    const capabilities = new BriefCapabilities(
      [{ id: "profileSettings", provider: service }],
      ["profileSettings"],
    );
    routes = createProfileSettingsRoutes(
      capabilities,
      (body: unknown, status = 200) => Response.json(body, { status }),
      service,
    );
  };
  connect();
  const port = createProfilePort("temporary-vault", {
    canWrite: true,
    async request(path, init) {
      assert.ok(
        [
          "/api/brief/profile-settings",
          "/api/brief/profile-settings/profile",
        ].includes(path),
      );
      const method = init.method ?? "GET";
      const response = await routes[path][method](
        new Request(`http://fixture.invalid${path}`, init),
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (method === "PATCH") {
        writes++;
        if (loseReply && response.ok) {
          loseReply = false;
          throw Error("Fixture lost acknowledgment");
        }
      }
      return response;
    },
  });
  const mount = async () => {
    controller?.retire();
    controller = new ProfileController(port);
    controller.setAccess(true);
    for (let i = 0; i < 200 && controller.snapshot().reading; i++)
      await Bun.sleep(5);
    assert.equal(controller.snapshot().availability, "ready");
    return controller;
  };
  let form = await mount();
  assert.equal(form.value("work_role"), "Founder\nDesigner");
  for (const [key, value] of Object.entries({
    preferred_name: "  Sam  ",
    company: "Example studio",
    work_role: "Founder\nResearcher",
    current_projects: "Project one\nProject two",
    communication_preferences: "Concise answers",
  })) {
    form.edit(key as any, value);
    await form.save();
    assert.equal(form.snapshot().phase, "saved");
    assert.equal(service.profile().answers[key], value.trim());
  }
  assert.equal(getUserProfile().answers.interests, "Space");
  assert.equal(getUserProfile().interview_facts[0].summary, "Morning focus");
  const saved = service.profile();
  controller!.retire();
  closeDb();
  initDatabase(file, { quiet: true });
  connect();
  form = await mount();
  assert.deepEqual(form.snapshot().base, saved);
  form.edit("company", " ");
  await form.save();
  assert.equal(service.profile().answers.company, undefined);
  form.edit("company", "Stale draft");
  const revision = form.snapshot().base!.revision;
  saveUserProfile({
    ...getUserProfile().answers,
    company: "External correction",
  });
  await form.refresh();
  assert.equal(form.value("company"), "Stale draft");
  assert.equal(form.snapshot().base!.revision, revision);
  await form.save();
  assert.equal(form.snapshot().phase, "conflict");
  assert.equal(service.profile().answers.company, "External correction");
  form.cancel();
  await form.resolvePrompt(true);
  assert.equal(form.value("company"), "External correction");
  form.edit("company", "Lost acknowledgment");
  loseReply = true;
  await form.save();
  assert.equal(form.snapshot().phase, "unknown");
  const applied = service.profile(),
    facts = findFacts({ predicate: "company" });
  await form.save();
  assert.equal(form.snapshot().phase, "saved");
  assert.deepEqual(service.profile(), applied);
  assert.deepEqual(findFacts({ predicate: "company" }), facts);
  getDb().run(
    "CREATE TRIGGER refuse_profile_fact BEFORE INSERT ON facts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  );
  form.edit("company", "Failed save draft");
  await form.save();
  assert.equal(form.snapshot().phase, "unknown");
  assert.deepEqual(service.profile(), applied);
  assert.equal(form.value("company"), "Failed save draft");
  getDb().run("DROP TRIGGER refuse_profile_fact");
  await form.save();
  assert.equal(form.snapshot().phase, "saved");
  assert.equal(service.profile().answers.company, "Failed save draft");
  process.env.JARVIS_BRIEF_PROFILE_SETTINGS = "0";
  await form.refresh();
  assert.equal(form.snapshot().availability, "stale");
  const count = writes;
  await form.save();
  assert.equal(writes, count);
  assert.equal(getUserProfile().answers.interests, "Space");
  assert.equal(getUserProfile().interview_facts[0].summary, "Morning focus");
  console.log(
    JSON.stringify(
      {
        card: "D-29",
        provider: pin,
        result: "pass",
        writes,
        proofs: [
          "actual F23 routes and canonical SQLite provider",
          "six-field ownership contract",
          "five editable canonical mappings",
          "multiline and clear",
          "hidden answers and interview preservation",
          "restart/readback",
          "dirty-poll CAS conflict",
          "lost acknowledgment idempotent retry",
          "atomic failure and explicit retry",
          "disabled provider prevents save",
        ],
        isolation: "temporary SQLite and secrets; no network or account writes",
      },
      null,
      2,
    ),
  );
} finally {
  controller?.retire();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
}
