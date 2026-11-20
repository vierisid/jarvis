/**
 * A stand-in for the engine's source, for tests: a folder with a script of
 * the same name that says the same sentences, and a build script that writes
 * what a build writes. Nothing of the real one is here.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
case "\${1:-}" in
start)
  if [ ! -f "$HERE/.env" ]; then echo "NGROK_DOMAIN=\${NGROK_DOMAIN:?}" > "$HERE/.env"; mkdir -p "$HERE/data"; echo db > "$HERE/data/collab.sqlite"; fi
  . "$HERE/.env"
  if [ "$NGROK_DOMAIN" = "wrong.example.com" ]; then echo "test-env: ngrok exited (log: somewhere)" >&2; exit 1; fi
  if [ -f "$HERE/no-tunnel-program" ]; then echo "test-env: ngrok is not installed" >&2; exit 1; fi
  trap 'echo stopped > "$HERE/stopped"; exit 130' INT TERM
  echo "test-env: starting the server"
  echo
  echo "Server is up: https://$NGROK_DOMAIN"
  echo
  echo "home=$HOME secret=\${ANTHROPIC_API_KEY:-none} jarvis=\${JARVIS_AUTH_TOKEN:-none}" > "$HERE/saw"
  while true; do sleep 0.1; done ;;
account)
  if [ "$2" = "leo" ]; then echo "error: login name taken" >&2; exit 1; fi
  echo "created account 0123 (login $2)"; echo "password: pw-$2"; echo "Sign in at somewhere with login '$2'." ;;
password) echo "password changed; existing sessions were revoked"; echo "password: new-$2" ;;
*) exit 2 ;;
esac
`;
const BUILDER = `import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const out = args[args.indexOf('--outdir') + 1]!;
const target = args[args.indexOf('--target') + 1]!;
if (target === 'bun-linux-arm64') process.exit(1);
mkdirSync(join(out, 'plugin', 'runtime'), { recursive: true });
mkdirSync(join(out, '.claude-plugin'), { recursive: true });
writeFileSync(join(out, '.claude-plugin', 'marketplace.json'), JSON.stringify({ server: process.env.COLLAB_OFFICIAL_SERVER_URL, key: process.env.ANTHROPIC_API_KEY ?? 'none' }));
const program = new Uint8Array(6000);
program.set(target.includes('windows') ? [0x4d, 0x5a] : target.includes('darwin') ? [0xcf, 0xfa, 0xed, 0xfe] : [0x7f, 0x45, 0x4c, 0x46]);
const file = join(out, 'plugin', 'runtime', target.includes('windows') ? 'collab-claude.exe' : 'collab-claude');
writeFileSync(file, program);
chmodSync(file, 0o755);
`;

/** Makes the folder and gives its place. */
export function fakeSource(): string {
  const dir = mkdtempSync(join(tmpdir(), 'peers-host-'));
  mkdirSync(join(dir, 'deploy', 'ngrok'), { recursive: true });
  writeFileSync(join(dir, 'deploy', 'ngrok', 'test-env.sh'), SCRIPT);
  chmodSync(join(dir, 'deploy', 'ngrok', 'test-env.sh'), 0o755);
  mkdirSync(join(dir, 'packages', 'connector-claude-code', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'connector-claude-code', 'scripts', 'build-plugin.ts'), BUILDER);
  return dir;
}
