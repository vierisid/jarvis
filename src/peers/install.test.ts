import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_TARGETS, engineArchiveEntry, engineArchiveName, engineTarget, fetchEngine, installedEngine, installedEnginePath,
  peerServerAddress,
} from './install.ts';
import { ZipBad, zipEntries, zipRead, zipWrite } from './zip.ts';

const elf = (size = 5000): Uint8Array => { const bytes = new Uint8Array(size); bytes.set([0x7f, 0x45, 0x4c, 0x46]); for (let n = 4; n < size; n++) bytes[n] = (n * 7) % 251; return bytes; };
const folder = (): string => mkdtempSync(join(tmpdir(), 'peers-install-'));
const served = (body: Uint8Array | null, status = 200, seen: string[] = []) => (async (url: string | URL | Request, init?: RequestInit) => {
  seen.push(String(url), JSON.stringify(init?.headers ?? {}), String(init?.redirect));
  return new Response(body as BodyInit | null, { status });
}) as unknown as typeof fetch;

describe('a zip archive', () => {
  test('what is written is read back, byte for byte, with its mode', async () => {
    const big = elf(300_000);
    const archive = await zipWrite([{ name: 'a/b/program', bytes: big, mode: 0o755 }, { name: 'a/notes.txt', bytes: new TextEncoder().encode('hello') }, { name: 'a/empty', bytes: new Uint8Array(0) }]);
    const entries = zipEntries(archive);
    expect(entries.map((one) => one.name)).toEqual(['a/b/program', 'a/notes.txt', 'a/empty']);
    expect(entries[0]!.mode! & 0o777).toBe(0o755);
    expect(entries[1]!.mode! & 0o777).toBe(0o644);
    // The large one is packed, the five letters are not.
    expect(entries[0]!.method).toBe(8);
    expect(entries[1]!.method).toBe(0);
    expect(Buffer.from(await zipRead(archive, entries[0]!, 1_000_000)).equals(Buffer.from(big))).toBe(true);
    expect(new TextDecoder().decode(await zipRead(archive, entries[1]!, 100))).toBe('hello');
    expect((await zipRead(archive, entries[2]!, 100)).length).toBe(0);
  });

  test('the same files make the same archive', async () => {
    const files = [{ name: 'x', bytes: elf(9000) }];
    expect(Buffer.from(await zipWrite(files)).equals(Buffer.from(await zipWrite(files)))).toBe(true);
  });

  test('a file larger than is taken is refused before it is unpacked', async () => {
    const archive = await zipWrite([{ name: 'x', bytes: elf(50_000) }]);
    await expect(zipRead(archive, zipEntries(archive)[0]!, 49_999)).rejects.toBeInstanceOf(ZipBad);
  });

  test('a file that is not what the list says is refused', async () => {
    const archive = await zipWrite([{ name: 'x', bytes: new TextEncoder().encode('plain words, stored as they are') }]);
    const entry = zipEntries(archive)[0]!;
    // One letter of the stored file changed: its checksum no longer holds.
    const changed = archive.slice();
    changed[30 + 1 + 3] = changed[30 + 1 + 3]! ^ 1;
    await expect(zipRead(changed, entry, 1000)).rejects.toBeInstanceOf(ZipBad);
    // A list that promises less than unpacks.
    const packed = await zipWrite([{ name: 'x', bytes: elf(50_000) }]);
    await expect(zipRead(packed, { ...zipEntries(packed)[0]!, size: 100 }, 1_000_000)).rejects.toBeInstanceOf(ZipBad);
  });

  test('what is not an archive, or is cut short, is refused', async () => {
    expect(() => zipEntries(new Uint8Array(10))).toThrow(ZipBad);
    expect(() => zipEntries(new TextEncoder().encode('<html>You are about to visit a site</html>'.repeat(20)))).toThrow(ZipBad);
    const archive = await zipWrite([{ name: 'x', bytes: elf(9000) }]);
    expect(() => zipEntries(archive.subarray(0, archive.length - 30))).toThrow(ZipBad);
    const entry = zipEntries(archive)[0]!;
    await expect(zipRead(archive, { ...entry, offset: archive.length - 10 }, 100_000)).rejects.toBeInstanceOf(ZipBad);
    await expect(zipRead(archive, { ...entry, packed: archive.length }, 100_000)).rejects.toBeInstanceOf(ZipBad);
  });
});

describe('the build for a system', () => {
  test('is named as the builds are', () => {
    expect(engineTarget('linux', 'x64')).toBe('linux-x64');
    expect(engineTarget('darwin', 'arm64')).toBe('darwin-arm64');
    expect(engineTarget('win32', 'x64')).toBe('windows-x64');
    expect(engineTarget('win32', 'arm64')).toBeNull();
    expect(engineTarget('freebsd', 'x64')).toBeNull();
    expect(engineTarget('linux', 'ia32')).toBeNull();
    expect(ENGINE_TARGETS.length).toBe(5);
    expect(engineArchiveName('darwin-arm64')).toBe('collab-plugin-darwin-arm64.zip');
    expect(engineArchiveEntry('windows-x64')).toBe('collab-plugin-windows-x64/plugin/runtime/collab-claude.exe');
    expect(installedEnginePath('/data', 'windows-x64')).toBe(join('/data', 'peers', 'bin', 'collab-claude.exe'));
  });
});

describe('a server address as it was typed', () => {
  test('becomes one form', () => {
    expect(peerServerAddress('northwind.ngrok-free.app')).toBe('https://northwind.ngrok-free.app');
    expect(peerServerAddress('  HTTPS://Northwind.ngrok-free.app/  ')).toBe('https://northwind.ngrok-free.app');
    expect(peerServerAddress('https://collab.example.com:8443/some/page?x=1')).toBe('https://collab.example.com:8443');
    expect(peerServerAddress('http://localhost:18787')).toBe('http://localhost:18787');
    expect(peerServerAddress('http://127.0.0.1:18787/')).toBe('http://127.0.0.1:18787');
  });

  test('plain http is this machine only, and nothing odd is taken', () => {
    expect(peerServerAddress('http://northwind.ngrok-free.app')).toBeNull();
    expect(peerServerAddress('http://localhost.evil.example')).toBeNull();
    expect(peerServerAddress('ftp://northwind.example')).toBeNull();
    expect(peerServerAddress('https://someone:secret@northwind.example')).toBeNull();
    expect(peerServerAddress('northwind')).toBeNull();
    expect(peerServerAddress('')).toBeNull();
    expect(peerServerAddress('javascript:alert(1)')).toBeNull();
    expect(peerServerAddress(`${'a'.repeat(300)}.example`)).toBeNull();
  });
});

describe('taking the engine from a server', () => {
  const target = 'linux-x64' as const;
  const archiveOf = (bytes: Uint8Array, name = engineArchiveEntry(target)) => zipWrite([{ name: 'collab-plugin-linux-x64/.claude-plugin/marketplace.json', bytes: new TextEncoder().encode('{}') }, { name, bytes, mode: 0o755 }]);

  test('puts the program in place, to be run', async () => {
    const dir = folder();
    const program = elf(20_000);
    const seen: string[] = [];
    const got = await fetchEngine({ server: 'northwind.ngrok-free.app', brainDataDir: dir, target, fetch: served(await archiveOf(program), 200, seen) });
    expect(got).toEqual({ ok: true, path: installedEnginePath(dir, target) });
    expect(Buffer.from(readFileSync(installedEnginePath(dir, target))).equals(Buffer.from(program))).toBe(true);
    if (process.platform !== 'win32') expect(statSync(installedEnginePath(dir, target)).mode & 0o111).toBe(0o111);
    expect(installedEngine(dir, target)).toBe(installedEnginePath(dir, target));
    expect(seen[0]).toBe('https://northwind.ngrok-free.app/plugin/collab-plugin-linux-x64.zip');
    // It does not follow the server anywhere else.
    expect(seen[2]).toBe('error');
    expect(seen[1]).toContain('ngrok-skip-browser-warning');
  });

  test('says why when there is nothing to take', async () => {
    const dir = folder();
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(null, 404) })).toEqual({ ok: false, why: 'no_build' });
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(null, 502) })).toEqual({ ok: false, why: 'unreachable' });
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: (async () => { throw new Error('no line'); }) as unknown as typeof fetch })).toEqual({ ok: false, why: 'unreachable' });
    expect(await fetchEngine({ server: 'http://northwind.example', brainDataDir: dir, target, fetch: served(null, 200) })).toEqual({ ok: false, why: 'unreachable' });
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target: null, fetch: served(null, 200) })).toEqual({ ok: false, why: 'system' });
    expect(installedEngine(dir, target)).toBeNull();
  });

  test('takes nothing that is not the engine for this system', async () => {
    const dir = folder();
    const page = new TextEncoder().encode('<html>You are about to visit</html>'.repeat(50));
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(page) })).toEqual({ ok: false, why: 'bad' });
    // An archive with no program under the build's name.
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(await archiveOf(elf(20_000), 'collab-plugin-linux-x64/plugin/runtime/other')) })).toEqual({ ok: false, why: 'bad' });
    // A program for another system under this one's name.
    const windows = elf(20_000); windows.set([0x4d, 0x5a, 0x90, 0x00]);
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(await archiveOf(windows)) })).toEqual({ ok: false, why: 'bad' });
    // A script.
    expect(await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(await archiveOf(new TextEncoder().encode(`#!/bin/sh\n${'echo hello\n'.repeat(500)}`))) })).toEqual({ ok: false, why: 'bad' });
    expect(installedEngine(dir, target)).toBeNull();
  });

  test('an engine that was in place stays when the new one is refused', async () => {
    const dir = folder();
    const first = elf(20_000);
    await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(await archiveOf(first)) });
    await fetchEngine({ server: 'northwind.example', brainDataDir: dir, target, fetch: served(new Uint8Array(500)) });
    expect(Buffer.from(readFileSync(installedEnginePath(dir, target))).equals(Buffer.from(first))).toBe(true);
  });
});
