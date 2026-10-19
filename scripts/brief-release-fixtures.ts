/** Reproduce test-only schema/legacy-reader fixtures from the locally fetched, pinned repository objects. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// 'pre-brief' is the roadmap baseline. 'main' is the last main before the F stack started landing
// (v0.16.0 plus 8 commits), i.e. the schema a released install upgrades from, not today's main.
const revisions = { 'pre-brief': '69211511c95355776c6c319c01e1df5acd3b8f1e', main: '8a0da716ed476f51327a7f22e1d30327edbca0a2' };
// A hook-invoked run inherits GIT_DIR/GIT_INDEX_FILE; resolve the repository from cwd instead.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const sources = ['src/vault/schema.ts', 'src/vault/fact-schema.ts', 'src/vault/fact-policy.ts', 'src/vault/goal-event-schema.ts',
  'src/vault/suggestion-schema.ts', 'src/user/profile.ts', 'src/workflows/db/schema.ts', 'src/workflows/db/flow-graph.ts', 'src/vault/conversations.ts'];
const output = join(import.meta.dir, '../src/brief/release/fixtures');
const inventory: Record<string, unknown> = {};
for (const [name, revision] of Object.entries(revisions)) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-f28-fixture-'));
  try {
    const hashes: Record<string, string> = {};
    for (const path of sources) {
      const result = Bun.spawnSync(['git', 'show', `${revision}:${path}`], { cwd: join(import.meta.dir, '..'), env: gitEnv });
      if (result.exitCode) throw Error(`Pinned source unavailable: ${revision}:${path}`);
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), result.stdout);
      hashes[path] = createHash('sha256').update(result.stdout).digest('hex');
    }
    const generate = `import { initDatabase, closeDb } from './src/vault/schema.ts';
      import { createSchema } from './src/workflows/db/schema.ts';
      const db = initDatabase(':memory:', {quiet:true}); createSchema(db);
      const rows = db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type='table' DESC, name").all();
      await Bun.write(${JSON.stringify(join(output, `${name}.sql`))}, rows.map(x => x.sql + ';\\n').join('\\n')); closeDb();`;
    writeFileSync(join(directory, 'generate.ts'), generate);
    const result = Bun.spawnSync([process.execPath, join(directory, 'generate.ts')], { cwd: directory });
    if (result.exitCode) throw Error(result.stderr.toString());
    writeFileSync(join(output, `${name}-conversations.ts.txt`), readFileSync(join(directory, 'src/vault/conversations.ts')));
    inventory[name] = { revision, sources: hashes, schemaSha256: createHash('sha256').update(readFileSync(join(output, `${name}.sql`))).digest('hex') };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
writeFileSync(join(output, 'provenance.json'), JSON.stringify(inventory, null, 2) + '\n');
