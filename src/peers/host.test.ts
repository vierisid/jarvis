import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerHost, canHost, hostAddress, hostEnv, hostFailure, hostIdent, peerLoginName, signInByForm, tunnelFailure } from './host.ts';
import { engineArchiveEntry, engineArchiveName, fetchEngine, installedEnginePath } from './install.ts';
import { fakeSource } from './testing/fake-source.ts';
import { zipEntries } from './zip.ts';

const source = fakeSource;
/** Whether a program is still there. */
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The stubborn program the stand-in script starts and never stops by itself. */
const stubborn = (dir: string): number => Number(readFileSync(join(dir, 'deploy', 'ngrok', 'child.pid'), 'utf8').trim());
const until = async (what: () => boolean, ms = 4000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (what()) return true; await Bun.sleep(20); } return what(); };
const env = { PATH: process.env.PATH, HOME: '/brain/home', ANTHROPIC_API_KEY: 'sk-secret', JARVIS_AUTH_TOKEN: 'token' };
const unix = process.platform !== 'win32';
/** The start time of a program, as `ps` words it. */
const lstartOf = async (pid: number): Promise<string | null> => {
  const ps = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  return (await new Response(ps.stdout).text()).trim() || null;
};
/** Which program a number is, as the watcher writes it down: the system's count where there is one, the start time elsewhere. */
const identOf = async (pid: number): Promise<string | null> => (existsSync('/proc/self/stat') ? hostIdent(pid) : lstartOf(pid));

describe('whether this machine can host', () => {
  test('only with the source named and its script there, and not on Windows itself', () => {
    const dir = source();
    expect(canHost(dir, 'linux')).toBe(true);
    expect(canHost(dir, 'darwin')).toBe(true);
    expect(canHost(dir, 'win32')).toBe(false);
    expect(canHost(null, 'linux')).toBe(false);
    expect(canHost(join(dir, 'nothing-here'), 'linux')).toBe(false);
  });
});

describe('a name at the server', () => {
  test('is made of the name that was typed', () => {
    expect(peerLoginName('Leo')).toBe('leo');
    expect(peerLoginName('Leo Rossi')).toBe('leo-rossi');
    expect(peerLoginName('  José  Ángel ')).toBe('jose-angel');
    expect(peerLoginName("Anna O'Neil")).toBe('anna-o-neil');
    expect(peerLoginName('a'.repeat(50))).toBe('a'.repeat(32));
    expect(peerLoginName('---')).toBeNull();
    expect(peerLoginName('李')).toBeNull();
  });
});

describe('what the scripts are given', () => {
  test('the allowlist, the real home, and the two settings: nothing of the brain\'s own', () => {
    const made = hostEnv({ ...env, JARVIS_WORKFLOW_ENCRYPTION_KEY: 'k', NGROK_AUTHTOKEN: 'x', COLLAB_SERVER_URL: 'https://other.example' }, { home: '/home/sam', runtimeDir: '/opt/bun/bin', domain: 'northwind.ngrok-free.app', server: 'https://northwind.ngrok-free.app' });
    expect(made.HOME).toBe('/home/sam');
    expect(made.PATH!.startsWith('/opt/bun/bin')).toBe(true);
    expect(made.NGROK_DOMAIN).toBe('northwind.ngrok-free.app');
    expect(made.COLLAB_OFFICIAL_SERVER_URL).toBe('https://northwind.ngrok-free.app');
    expect(Object.keys(made).sort()).toEqual(['COLLAB_OFFICIAL_SERVER_URL', 'HOME', 'NGROK_DOMAIN', 'PATH']);
  });

  test('what the script said went wrong is told apart by its own sentences', () => {
    expect(hostFailure('test-env: ngrok is not installed\n')).toEqual({ ok: false, why: 'tools', missing: 'ngrok' });
    expect(hostFailure('test-env: something already answers on port 8787 (another test environment?)\n')).toEqual({ ok: false, why: 'busy' });
    expect(hostFailure('lvl=eror msg="x"\ntest-env: ngrok exited (log: /x/ngrok.log)\n')).toEqual({ ok: false, why: 'tunnel' });
    // The tunnel program's own number, when the script passed it on.
    expect(hostFailure('ERROR:  ERR_NGROK_108\nERROR:  https://ngrok.com/docs/errors/err_ngrok_108\ntest-env: ngrok exited (log: /x/ngrok.log)\n')).toEqual({ ok: false, why: 'tunnel', code: '108' });
    expect(tunnelFailure("err=\"Failed to create an endpoint with the domain 'a.ngrok-free.dev' for the account 'Northwind Ops'.\"\nERROR:  ERR_NGROK_320\n")).toEqual({ code: '320', account: 'Northwind Ops' });
    expect(tunnelFailure('nothing of the kind')).toEqual({});
    // An older failure further up, a newer one below: the newer one is the reason.
    expect(tunnelFailure('ERR_NGROK_108\nlater\nERR_NGROK_320')).toEqual({ code: '320' });
    expect(hostFailure('test-env: ngrok did not answer at https://x/health\n')).toEqual({ ok: false, why: 'tunnel' });
    expect(hostFailure('anything else')).toEqual({ ok: false, why: 'failed' });
    // One of its own programs could not have its port.
    expect(hostFailure('error: Failed to start server. Is port 8788 in use?\n code: "EADDRINUSE"\ntest-env: the proxy exited (log: /x/proxy.log)\n')).toEqual({ ok: false, why: 'busy' });
  });
});

describe.if(unix)('the organisation\'s server', () => {
  test('starts with the address typed the first time, and stops when it is told to', async () => {
    const dir = source();
    const states: string[] = [];
    const host = new PeerHost({ source: dir, env, home: '/home/sam', onState: (state) => states.push(state) });
    expect(host.address()).toBeNull();
    expect(await host.start()).toEqual({ ok: false, why: 'address' });
    expect(await host.start('not an address')).toEqual({ ok: false, why: 'address' });
    expect(await host.start('http://localhost:8787')).toEqual({ ok: false, why: 'address' });
    expect(await host.start('Northwind.ngrok-free.app')).toEqual({ ok: true, address: 'https://northwind.ngrok-free.app' });
    expect(host.state()).toBe('on');
    expect(host.address()).toBe('https://northwind.ngrok-free.app');
    expect(hostAddress(dir)).toBe('https://northwind.ngrok-free.app');
    // Asked again while it is on: the same answer, and no second server.
    expect(await host.start()).toEqual({ ok: true, address: 'https://northwind.ngrok-free.app' });
    // The real home reached it, and nothing of the brain's own did.
    expect(await until(() => existsSync(join(dir, 'deploy', 'ngrok', 'saw')))).toBe(true);
    expect(readFileSync(join(dir, 'deploy', 'ngrok', 'saw'), 'utf8').trim()).toBe('home=/home/sam secret=none jarvis=none');
    await host.stop();
    expect(host.state()).toBe('off');
    // It was told to stop, and stopped in its own way: its tunnel and server go down in order.
    expect(existsSync(join(dir, 'deploy', 'ngrok', 'stopped'))).toBe(true);
    expect(states).toEqual(['starting', 'on', 'off']);
    // The second time it needs no address.
    expect(await host.start()).toEqual({ ok: true, address: 'https://northwind.ngrok-free.app' });
    await host.stop();
  });

  test('stopping ends everything the script started, also what it did not stop itself', async () => {
    const dir = source();
    const host = new PeerHost({ source: dir, env });
    expect((await host.start('northwind.ngrok-free.app')).ok).toBe(true);
    const left = stubborn(dir);
    expect(alive(left)).toBe(true);
    await host.stop();
    expect(existsSync(join(dir, 'deploy', 'ngrok', 'stopped'))).toBe(true);
    // Asked to go, it did not. It is ended with the rest of the script's group.
    expect(await until(() => !alive(left), 15_000)).toBe(true);
    // Nothing is written down as still running.
    expect(await until(() => !existsSync(join(dir, 'deploy', 'ngrok', 'data', 'start.pid')), 5000)).toBe(true);
  }, 30_000);

  test('a brain that is killed leaves nothing of the server behind', async () => {
    const dir = source();
    // The brain, as a program of its own: it starts the server, says so, and is then killed outright.
    const brain = Bun.spawn([process.execPath, '-e', `
      const { PeerHost } = await import(${JSON.stringify(join(import.meta.dir, 'host.ts'))});
      const host = new PeerHost({ source: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH, HOME: '/brain/home' } });
      const started = await host.start('northwind.ngrok-free.app');
      console.log(started.ok ? 'up' : 'failed');
      await new Promise(() => {});
    `], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const reader = brain.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.trim()).toBe('up');
    const left = stubborn(dir);
    expect(alive(left)).toBe(true);
    brain.kill('SIGKILL');
    await brain.exited;
    // The script goes out in its own way although nobody is left to hear its last word: on 23 November
    // 2026 that word, said into a pipe whose other end was gone, ended it before it had stopped anything.
    expect(await until(() => existsSync(join(dir, 'deploy', 'ngrok', 'stopped')), 15_000)).toBe(true);
    expect(await until(() => !alive(left), 15_000)).toBe(true);
  }, 40_000);

  test('a script an earlier brain left running is ended by the next start, and no other program is touched', async () => {
    const dir = source();
    const data = join(dir, 'deploy', 'ngrok', 'data');
    // An earlier start, left running with nobody watching it: in a group of its own, and written down.
    const old = Bun.spawn(['bash', '-c', 'set -m; mkdir -p "$2"; NGROK_DOMAIN=northwind.ngrok-free.app "$1" start </dev/null >>"$2/start.log" 2>&1 & echo $!', 'old', join(dir, 'deploy', 'ngrok', 'test-env.sh'), data],
      { env: { PATH: process.env.PATH ?? '', HOME: '/brain/home' }, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const oldPid = Number((await new Response(old.stdout).text()).trim());
    writeFileSync(join(data, 'start.pid'), `${oldPid}\n${await identOf(oldPid)}\n`);
    expect(await until(() => existsSync(join(dir, 'deploy', 'ngrok', 'child.pid')))).toBe(true);
    const oldChild = stubborn(dir);
    expect(alive(oldPid) && alive(oldChild)).toBe(true);
    const logged: string[] = [];
    const host = new PeerHost({ source: dir, env, log: (line) => logged.push(line) });
    expect((await host.start()).ok).toBe(true);
    expect(logged).toContain('[peers] a server that an earlier brain left running is stopped first');
    expect(alive(oldPid)).toBe(false);
    expect(await until(() => !alive(oldChild), 10_000)).toBe(true);
    await host.stop();
    // What is written down but is another program by now (the same number, another start time) is left alone.
    rmSync(join(dir, 'deploy', 'ngrok', 'stopped'), { force: true });
    const bystander = Bun.spawn(['sleep', '120'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
    try {
      // Another count, another start time, and a start time as `ps` words it where the count is what is kept.
      const others = ['ticks 1', 'Mon Jan  1 00:00:00 2001', (await lstartOf(bystander.pid)) ?? 'Tue Jan  2 00:00:00 2001'];
      for (const other of process.platform === 'linux' ? others : others.slice(0, 2)) {
        rmSync(join(dir, 'deploy', 'ngrok', 'stopped'), { force: true });
        writeFileSync(join(data, 'start.pid'), `${bystander.pid}\n${other}\n`);
        const again = new PeerHost({ source: dir, env, log: (line) => logged.push(line) });
        expect((await again.start()).ok).toBe(true);
        await Bun.sleep(300);
        expect(alive(bystander.pid)).toBe(true);
        expect(logged.filter((line) => line.includes('left running')).length).toBe(1);
        await again.stop();
      }
    } finally {
      bystander.kill();
    }
  }, 90_000);

  test('which program the script is, is written down by a count the clock of the day cannot move', async () => {
    const dir = source();
    const host = new PeerHost({ source: dir, env });
    expect((await host.start('northwind.ngrok-free.app')).ok).toBe(true);
    try {
      const [pid, ident] = readFileSync(join(dir, 'deploy', 'ngrok', 'data', 'start.pid'), 'utf8').split('\n');
      expect(alive(Number(pid))).toBe(true);
      // The watcher writes what the brain reads: otherwise the next start would not know its own script.
      expect(ident ?? null).toBe(await identOf(Number(pid)));
      if (process.platform === 'linux') {
        // On 23 November 2026 the start time `ps` gives for a running script moved by four minutes,
        // with the clock, on the machine this runs on. The count since the machine was switched on does not.
        expect(ident).toMatch(/^ticks \d+$/);
        expect(hostIdent(Number(pid))).toBe(ident!);
        expect(hostIdent(Number(pid))).toBe(hostIdent(Number(pid)));
      }
    } finally {
      await host.stop();
    }
    expect(hostIdent(2 ** 30)).toBeNull();
  }, 30_000);

  test('a server whose brain is gone is gone too', async () => {
    const dir = source();
    let child: { close(): void } | null = null;
    const host = new PeerHost({
      source: dir, env,
      run: (words, more) => {
        const real = Bun.spawn(words, { cwd: more.cwd, env: more.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
        child = { close: () => { void real.stdin.end(); } };
        return { stdout: real.stdout, stderr: real.stderr, exited: real.exited.then((code) => code, () => null), close: () => { /* the brain never says stop */ }, kill: () => real.kill('SIGKILL') };
      },
    });
    expect((await host.start('northwind.ngrok-free.app')).ok).toBe(true);
    // The brain's end of the pipe closes, as it does when the brain is killed.
    child!.close();
    expect(await until(() => existsSync(join(dir, 'deploy', 'ngrok', 'stopped')))).toBe(true);
    expect(await until(() => host.state() === 'off')).toBe(true);
  });

  test('a start that fails says why, and leaves nothing of a first try behind', async () => {
    const dir = source();
    const host = new PeerHost({ source: dir, env });
    const logged: string[] = [];
    const failing = new PeerHost({ source: dir, env, log: (line) => logged.push(line) });
    // The tunnel program's own reason comes with it: its number, and the account it named.
    expect(await failing.start('wrong.example.com')).toEqual({ ok: false, why: 'tunnel', code: '320', account: 'Northwind Ops' });
    expect(host.state()).toBe('off');
    // The log has the number and not the account's name.
    expect(logged).toContain("[peers] the organisation's server did not start (tunnel, ERR_NGROK_320)");
    expect(logged.join('\n')).not.toContain('Northwind Ops');
    // The mistyped address is gone with the database that was made for it: the next try is a first try again.
    expect(host.address()).toBeNull();
    expect(existsSync(join(dir, 'deploy', 'ngrok', 'data', 'collab.sqlite'))).toBe(false);
    // What the tunnel program wrote is kept: it is how the failure is understood afterwards.
    expect(readFileSync(join(dir, 'deploy', 'ngrok', 'data', 'ngrok.log'), 'utf8')).toContain('ERR_NGROK_320');
    expect((await host.start('northwind.ngrok-free.app')).ok).toBe(true);
    await host.stop();
    // A later failure takes nothing away: the address and the accounts are kept.
    writeFileSync(join(dir, 'deploy', 'ngrok', 'no-tunnel-program'), '');
    expect(await host.start()).toEqual({ ok: false, why: 'tools', missing: 'ngrok' });
    expect(host.address()).toBe('https://northwind.ngrok-free.app');
    expect(existsSync(join(dir, 'deploy', 'ngrok', 'data', 'collab.sqlite'))).toBe(true);
  });

  test('a start that never comes up is ended', async () => {
    const dir = source();
    writeFileSync(join(dir, 'deploy', 'ngrok', 'test-env.sh'), '#!/usr/bin/env bash\ntrap \'exit 130\' TERM\nwhile true; do sleep 0.1; done\n');
    const host = new PeerHost({ source: dir, env, startMs: 300 });
    writeFileSync(join(dir, 'deploy', 'ngrok', '.env'), 'NGROK_DOMAIN=northwind.ngrok-free.app\n');
    expect(await host.start()).toEqual({ ok: false, why: 'failed' });
    expect(host.state()).toBe('off');
    // What was there before the start is not taken away.
    expect(host.address()).toBe('https://northwind.ngrok-free.app');
  });

  test('makes an account and gives its password once', async () => {
    const dir = source();
    const logged: string[] = [];
    const host = new PeerHost({ source: dir, env, log: (line) => logged.push(line) });
    // No server was ever set up: there is nowhere to make an account.
    expect(await host.account('Anna')).toEqual({ ok: false, why: 'name' });
    await host.start('northwind.ngrok-free.app');
    expect(await host.account('Anna Bianchi')).toEqual({ ok: true, password: 'pw-anna-bianchi' });
    expect(await host.account('Leo')).toEqual({ ok: false, why: 'taken' });
    expect(await host.account('---')).toEqual({ ok: false, why: 'name' });
    expect(await host.newPassword('Anna Bianchi')).toEqual({ ok: true, password: 'new-anna-bianchi' });
    await host.stop();
    expect(logged.join('\n')).not.toContain('pw-');
    expect(logged.join('\n')).not.toContain('new-anna');
  });

  test('builds the engine for a system and packs it where a joiner takes it from', async () => {
    const dir = source();
    const host = new PeerHost({ source: dir, env });
    // No address yet: a build would not know its server.
    expect(await host.build('linux-x64')).toBe(false);
    await host.start('northwind.ngrok-free.app');
    expect(host.built()).toEqual([]);
    expect(await host.build('darwin-arm64')).toBe(true);
    expect(host.built()).toEqual(['darwin-arm64']);
    expect(host.program('darwin-arm64')).toBe(join(dir, 'deploy', 'ngrok', 'dist', 'collab-plugin-darwin-arm64', 'plugin', 'runtime', 'collab-claude'));
    const archive = readFileSync(join(dir, 'deploy', 'ngrok', 'dist', engineArchiveName('darwin-arm64')));
    const entries = zipEntries(archive);
    expect(entries.map((one) => one.name).sort()).toEqual(['collab-plugin-darwin-arm64/.claude-plugin/marketplace.json', engineArchiveEntry('darwin-arm64')]);
    expect(entries.find((one) => one.name === engineArchiveEntry('darwin-arm64'))!.mode! & 0o777).toBe(0o755);
    // The build was told its server, and nothing of the brain's own.
    expect(JSON.parse(readFileSync(join(dir, 'deploy', 'ngrok', 'dist', 'collab-plugin-darwin-arm64', '.claude-plugin', 'marketplace.json'), 'utf8'))).toEqual({ server: 'https://northwind.ngrok-free.app', key: 'none' });
    // A joiner on that system takes exactly that program.
    const joiner = mkdtempSync(join(tmpdir(), 'peers-joiner-'));
    const got = await fetchEngine({ server: 'northwind.ngrok-free.app', brainDataDir: joiner, target: 'darwin-arm64', fetch: (async () => new Response(archive)) as unknown as typeof fetch });
    expect(got.ok).toBe(true);
    expect(Buffer.from(readFileSync(installedEnginePath(joiner, 'darwin-arm64'))).equals(readFileSync(host.program('darwin-arm64')!))).toBe(true);
    // A build that fails leaves no archive.
    expect(await host.build('linux-arm64')).toBe(false);
    expect(host.built()).toEqual(['darwin-arm64']);
    await host.stop();
  });
});

describe('signing in at the server\'s own page', () => {
  const page = '<html><body><form method="post" action="/auth/authorize?x=1&amp;y=2"><input type="hidden" name="csrf" value="c-1"><input type="hidden" name="request" value="a&quot;b"><input name="login"><input name="password" type="password"></form></body></html>';
  function server(more: { status?: number; back?: string; page?: string } = {}) {
    const calls: { url: string; method: string; cookie: string; body: string }[] = [];
    const get = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), method: init?.method ?? 'GET', cookie: headers.cookie ?? '', body: String(init?.body ?? '') });
      const at = String(url);
      if (at === 'https://northwind.example/auth/start?id=7') return new Response(null, { status: 302, headers: { location: '/auth/authorize?id=7', 'set-cookie': 'session=s-1; Path=/; HttpOnly' } });
      if (at === 'https://northwind.example/auth/authorize?id=7') return new Response(more.page ?? page, { status: 200, headers: { 'set-cookie': 'csrf=c-1; Path=/' } });
      if (init?.method === 'POST') return new Response(null, { status: more.status ?? 303, headers: { location: more.back ?? 'http://127.0.0.1:41234/callback?code=abc' } });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, get };
  }

  test('fills in the form as a browser would and tells the engine on this machine', async () => {
    const { calls, get } = server();
    expect(await signInByForm('https://northwind.example/auth/start?id=7', 'northwind.example', 'anna', 'pw-anna', get)).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://northwind.example/auth/start?id=7',
      'GET https://northwind.example/auth/authorize?id=7',
      'POST https://northwind.example/auth/authorize?x=1&y=2',
      'GET http://127.0.0.1:41234/callback?code=abc',
    ]);
    expect(calls[2]!.cookie).toBe('session=s-1; csrf=c-1');
    expect(Object.fromEntries(new URLSearchParams(calls[2]!.body))).toEqual({ csrf: 'c-1', request: 'a"b', login: 'anna', password: 'pw-anna' });
    // The engine's door gets no cookie of the server's.
    expect(calls[3]!.cookie).toBe('');
  });

  test('a wrong password, or an answer that leads anywhere but this machine, is not a sign-in', async () => {
    expect(await signInByForm('https://northwind.example/auth/start?id=7', 'northwind.example', 'anna', 'wrong', server({ status: 200 }).get)).toBe(false);
    const away = server({ back: 'https://elsewhere.example/callback?code=abc' });
    expect(await signInByForm('https://northwind.example/auth/start?id=7', 'northwind.example', 'anna', 'pw', away.get)).toBe(false);
    expect(away.calls.some((call) => call.url.includes('elsewhere'))).toBe(false);
  });

  test('the password goes to the server it was made at and nowhere else', async () => {
    // The page is somewhere else.
    const other = server();
    expect(await signInByForm('https://elsewhere.example/auth/start?id=7', 'northwind.example', 'anna', 'pw', other.get)).toBe(false);
    expect(other.calls.length).toBe(0);
    // The form posts somewhere else.
    const form = server({ page: page.replace('action="/auth/authorize?x=1&amp;y=2"', 'action="https://elsewhere.example/take"') });
    expect(await signInByForm('https://northwind.example/auth/start?id=7', 'northwind.example', 'anna', 'pw', form.get)).toBe(false);
    expect(form.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});
