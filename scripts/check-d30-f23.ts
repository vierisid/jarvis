/** Optional pinned sibling proof: no production provider import or real account writes. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSettingsPort } from "../ui/src/brief/account/settings/adapter";
import { SettingsController } from "../ui/src/brief/account/settings/controller";
const root = process.env.D30_F23_ROOT;
if (!root) throw Error("Set D30_F23_ROOT to the pinned F23 checkout");
const pin = "13beb76554514227e0fb2fa476e7cd78f5432053",
  pinEnv = { ...process.env };
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
const dir = mkdtempSync(join(tmpdir(), "d30-f23-"));
process.env.JARVIS_SECRETS_DIR = join(dir, "secrets");
process.env.JARVIS_BRIEF_PROFILE_SETTINGS = "1";
const { initDatabase, closeDb, getDb } = await load("src/vault/schema.ts");
const { getSetting } = await load("src/vault/settings.ts");
const { persistUserPatch, saveUserSection } = await load(
  "src/daemon/user-settings.ts",
);
const { saveUserProfile, getUserProfile } = await load(
  "src/vault/user-profile.ts",
);
const { ProfileSettings } = await load("src/brief/profile-settings.ts");
const { createProfileSettingsRoutes } = await load(
  "src/brief/profile-settings-routes.ts",
);
const { BriefCapabilities } = await load("src/brief/capabilities.ts");
const { DEFAULT_CONFIG } = await load("src/config/types.ts");
let controller: SettingsController | undefined,
  writes = 0,
  loseReply = false,
  service: any,
  routes: any;
let config = structuredClone(DEFAULT_CONFIG);
const file = join(dir, "vault.db");
function connect(apply?: () => Promise<unknown>) {
  service = new ProfileSettings(config, apply);
  const caps = new BriefCapabilities(
    [{ id: "profileSettings", provider: service }],
    ["profileSettings"],
  );
  routes = createProfileSettingsRoutes(
    caps,
    (body: unknown, status = 200) => Response.json(body, { status }),
    service,
  );
}
const port = createSettingsPort("temporary-settings", {
  canWrite: true,
  destinations: {},
  async request(path, init) {
    assert.ok(
      [
        "/api/brief/profile-settings",
        "/api/brief/profile-settings/voice",
      ].includes(path),
    );
    const method = init.method ?? "GET";
    if (method === "PATCH") {
      writes++;
      assert.deepEqual(Object.keys(JSON.parse(String(init.body))).sort(), [
        "revision",
        "voice",
      ]);
    }
    const response = await routes[path][method](
      new Request(`http://fixture.invalid${path}`, init),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (method === "PATCH" && loseReply && response.ok) {
      loseReply = false;
      throw Error("Lost reply");
    }
    return response;
  },
});
async function mount() {
  controller?.retire();
  controller = new SettingsController(port);
  controller.setAccess(true);
  for (let i = 0; i < 200 && controller.snapshot().reading; i++)
    await Bun.sleep(5);
  assert.equal(controller.snapshot().availability, "ready");
  return controller;
}
try {
  initDatabase(file, { quiet: true });
  saveUserProfile({ preferred_name: "Alex", interests: "Space" });
  const profile = getUserProfile();
  saveUserSection("tts", {
    provider: "edge",
    enabled: true,
    rate: "+10%",
    elevenlabs: { api_key: "fixture-secret", voice_id: "existing" },
  });
  connect();
  let form = await mount();
  assert.equal(form.snapshot().base!.setup.deployment, "self_hosted");
  assert.equal(form.snapshot().base!.checkIn.state, "unavailable");
  await form.selectVoice("en-US-GuyNeural");
  assert.equal(form.snapshot().phase, "saved");
  assert.match(form.snapshot().message, /Restart Jarvis/);
  assert.equal(config.tts.elevenlabs.api_key, "fixture-secret");
  assert.deepEqual(JSON.parse(getSetting("cfg.tts")), {
    provider: "edge",
    enabled: true,
    rate: "+10%",
    elevenlabs: { voice_id: "existing" },
    voice: "en-US-GuyNeural",
  });
  assert.ok(!JSON.stringify(form.snapshot()).includes("fixture-secret"));
  const saved = form.snapshot().base;
  controller!.retire();
  closeDb();
  initDatabase(file, { quiet: true });
  config = structuredClone(DEFAULT_CONFIG);
  connect();
  form = await mount();
  assert.deepEqual(form.snapshot().base, saved);
  // A legacy writer invalidates the selected revision instead of being overwritten.
  persistUserPatch("tts", { rate: "+20%" });
  await form.selectVoice("en-GB-SoniaNeural");
  assert.equal(form.snapshot().phase, "conflict");
  assert.equal(JSON.parse(getSetting("cfg.tts")).rate, "+20%");
  await form.refresh(true);
  loseReply = true;
  await form.selectVoice("en-GB-SoniaNeural");
  assert.equal(form.snapshot().phase, "unknown");
  const count = writes;
  await form.save();
  assert.equal(writes, count);
  assert.equal(form.snapshot().phase, "saved");
  assert.match(form.snapshot().message, /unconfirmed/);
  connect(async () => {
    throw Error("isolated apply failure");
  });
  await form.selectVoice("en-US-AriaNeural");
  assert.equal(form.snapshot().phase, "saved");
  assert.match(form.snapshot().message, /could not be applied/);
  await form.refresh();
  assert.match(form.snapshot().message, /could not be applied/);
  connect(async () => undefined);
  await form.selectVoice("en-US-GuyNeural");
  assert.equal(form.snapshot().message, "Voice saved and applied.");
  // Hosted defaults remain silent and provider-managed; only the voice is persisted.
  getDb().run("DELETE FROM settings WHERE key = 'cfg.tts'");
  config = structuredClone(DEFAULT_CONFIG);
  config.usejarvis_ai = {
    base_url: "https://fixture.invalid",
    api_key: "fixture-hosted-key",
  };
  const system = JSON.stringify(config.usejarvis_ai);
  connect();
  form = await mount();
  assert.equal(form.snapshot().base!.setup.providerSetup, "managed");
  assert.equal(form.snapshot().base!.voice.enabled, false);
  await form.selectVoice("nova");
  assert.equal(form.snapshot().phase, "saved");
  assert.deepEqual(JSON.parse(getSetting("cfg.tts")), { voice: "nova" });
  assert.equal(JSON.stringify(config.usejarvis_ai), system);
  assert.equal(form.snapshot().base!.voice.enabled, false);
  controller!.retire();
  closeDb();
  initDatabase(file, { quiet: true });
  connect();
  form = await mount();
  assert.equal(form.value(), "nova");
  assert.equal(form.snapshot().base!.setup.providerSetup, "managed");
  assert.deepEqual(getUserProfile(), profile);
  process.env.JARVIS_BRIEF_PROFILE_SETTINGS = "0";
  await form.refresh();
  assert.equal(form.snapshot().availability, "stale");
  const finalCount = writes;
  await form.selectVoice("echo");
  assert.equal(writes, finalCount);
  console.log(
    JSON.stringify(
      {
        card: "D-30",
        provider: pin,
        result: "pass",
        writes,
        proofs: [
          "actual F23 routes and SQLite",
          "voice-only writes preserve provider, enabled, nested secrets and profile",
          "restart readback",
          "legacy writer revision conflict",
          "lost acknowledgment reconciles without second write",
          "saved/apply-failed and restart-required outcomes",
          "hosted silent defaults and managed setup",
          "disabled provider prevents save",
        ],
        isolation:
          "temporary vault and secrets; no network, audio or account writes",
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
