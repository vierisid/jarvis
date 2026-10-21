/**
 * #907: on Windows, run_command's shell fell back to a bare `powershell.exe`
 * when COMSPEC was unset, and a bare name can be found in the working
 * directory before System32. Built with an injected platform and env, so it
 * runs anywhere.
 */
import { describe, expect, test } from 'bun:test';
import { TerminalExecutor } from './executor.ts';

const ROOT = { SystemRoot: 'C:\\Windows' };
const SYSTEM32_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SYSTEM32_CMD = 'C:\\Windows\\System32\\cmd.exe';

describe('TerminalExecutor.detectShell on win32 (#907)', () => {
  test('COMSPEC, when it is a plain drive-absolute path, is the shell, whatever the key\'s case', () => {
    expect(TerminalExecutor.detectShell('win32', { ...ROOT, COMSPEC: 'C:\\Windows\\system32\\cmd.exe' })).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(TerminalExecutor.detectShell('win32', { ...ROOT, ComSpec: 'D:\\Win\\system32\\cmd.exe' })).toBe('D:\\Win\\system32\\cmd.exe');
  });

  test('without COMSPEC, powershell.exe by its absolute path under %SystemRoot%', () => {
    expect(TerminalExecutor.detectShell('win32', ROOT)).toBe(SYSTEM32_PS);
    expect(TerminalExecutor.detectShell('win32', { SystemRoot: 'E:\\WINNT' })).toBe('E:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  test('a COMSPEC that is not a plain drive-absolute path gives System32 cmd.exe, never the name itself', () => {
    for (const comspec of ['cmd.exe', '.\\cmd.exe', 'powershell.exe', '\\\\server\\share\\cmd.exe', 'C:\\Windows\\..\\Users\\x\\cmd.exe',
      'C:\\Windows/../Users/x/cmd.exe', 'C:\\x\\cmd.exe:ads']) {
      expect(TerminalExecutor.detectShell('win32', { ...ROOT, COMSPEC: comspec })).toBe(SYSTEM32_CMD);
    }
  });

  test('with no Windows directory in the environment it refuses, and only when a command runs', async () => {
    expect(() => TerminalExecutor.detectShell('win32', {})).toThrow('neither %SystemRoot% nor %WINDIR% names the Windows directory');
  });

  test('elsewhere, SHELL and then /bin/bash, as before', () => {
    expect(TerminalExecutor.detectShell('linux', { SHELL: '/usr/bin/zsh' })).toBe('/usr/bin/zsh');
    expect(TerminalExecutor.detectShell('darwin', {})).toBe('/bin/bash');
  });

  test('the shell is resolved at first use, so a refusal cannot fail construction', () => {
    const original = TerminalExecutor.detectShell;
    let calls = 0;
    TerminalExecutor.detectShell = () => { calls++; throw new Error('refused'); };
    try {
      const executor = new TerminalExecutor();
      expect(calls).toBe(0);
      expect(() => executor.getShell()).toThrow('refused');
      expect(new TerminalExecutor({ shell: '/bin/sh' }).getShell()).toBe('/bin/sh');
    } finally {
      TerminalExecutor.detectShell = original;
    }
  });

  test('a refused shell fails execute() and stream() with the reason, and nothing is run (#907 re-review)', async () => {
    const original = TerminalExecutor.detectShell;
    TerminalExecutor.detectShell = () => { throw new Error('neither %SystemRoot% nor %WINDIR% names the Windows directory'); };
    try {
      const executor = new TerminalExecutor();
      await expect(executor.execute('echo ran')).rejects.toThrow(
        'Command execution failed: neither %SystemRoot% nor %WINDIR% names the Windows directory');
      const chunks: string[] = [];
      let error: unknown;
      try {
        for await (const chunk of executor.stream('echo ran')) chunks.push(chunk);
      } catch (e) {
        error = e;
      }
      expect(chunks).toEqual([]);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('neither %SystemRoot% nor %WINDIR% names the Windows directory');
    } finally {
      TerminalExecutor.detectShell = original;
    }
  });
});
