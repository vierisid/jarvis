import { afterEach, describe, expect, test } from 'bun:test';
import { OWNER_WORD_ASKS_REASON, OWNER_WORD_UNSEEN_REASON, STILL_ASKED, callDeletesOrPays, commandDeletes, keysDelete, ownerWord, ownerWordAsks, setOwnerWordProbe } from './owner-word.ts';
import { ownerAskedOnNotch } from './app-open.ts';
import { withBriefTurn, type BriefExecutionContext } from '../brief/chat-context.ts';
import { turnContext } from './standing-fixture.ts';
import { NOTCH_SWITCH } from '../notch/switch.ts';

afterEach(() => setOwnerWordProbe(null));

const yes = () => true;
const no = () => false;

describe('what still asks when the owner asked for the thing', () => {
  test('a delete and a payment, and nothing else', () => {
    expect([...STILL_ASKED].sort()).toEqual(['delete_data', 'make_payment']);
  });

  test('a command that deletes is read from its text', () => {
    const missed: string[] = [];
    for (const command of [
      'rm notes.txt', 'rm -rf ~/old', 'sudo rm -rf /tmp/x', 'ls && rm a', 'ls; rmdir d', 'find . -name "*.tmp" | xargs rm',
      'find . -name "*.log" -delete', 'find . -type f -exec rm {} +', 'bash -c "rm -rf build"', "sh -c 'unlink a'",
      'del notes.txt', 'cmd /c del /q notes.txt', 'erase a.txt', 'rd /s /q old', 'rmdir /s old',
      'Remove-Item -Recurse old', 'powershell -Command "Remove-Item x"', 'Get-ChildItem *.tmp | Remove-Item', 'ri old.txt',
      'Clear-Content notes.txt', 'Clear-RecycleBin -Force', 'Uninstall-Package foo', 'Unregister-ScheduledTask -TaskName x',
      '[System.IO.File]::Delete("a.txt")', 'git clean -fd', 'git reset --hard HEAD~1', 'git rm old.txt', 'git branch -D feature',
      'git push origin --delete feature', 'git stash drop', 'rsync -a --delete a/ b/', 'robocopy a b /MIR',
      'docker rm web', 'docker image prune -a', 'docker system prune', 'kubectl delete pod web',
      'winget uninstall Steam', 'npm uninstall left-pad', 'pip uninstall requests -y', 'brew remove wget', 'apt-get purge nginx', 'pacman -Rns vim',
      'msiexec /x {GUID} /qn', 'reg delete HKCU\\Software\\X /f', 'schtasks /delete /tn Backup', 'net user sam /delete',
      'format d: /q', 'dd if=/dev/zero of=/dev/sdb', 'sqlite3 a.db "DROP TABLE notes"', 'psql -c "DELETE FROM users"',
      'python -c "import os; os.remove(\'a\')"', 'python3 -c "import shutil; shutil.rmtree(\'d\')"', 'node -e "fs.rmSync(\'d\', {recursive:true})"',
      '> notes.txt', 'echo done; > notes.txt', 'truncate -s 0 app.log', 'shred -u secret.txt', 'rimraf dist',
    ]) {
      if (!commandDeletes(command)) missed.push(command);
    }
    expect(missed).toEqual([]);
  });

  test('a delete written the other ordinary ways is read too', () => {
    const missed: string[] = [];
    for (const command of [
      // By its full path, or past the shell's own alias.
      '/bin/rm -rf ~/old', '/usr/bin/rm notes.txt', './rm notes.txt', '\\rm -rf build', 'C:\\Windows\\System32\\sdelete.exe -p 3 a.txt', 'ls && /bin/rm a',
      // Behind a word that only runs what follows, with or without its own options.
      'env rm notes.txt', 'env -i rm notes.txt', 'command rm notes.txt', 'nohup rm -rf build &', 'time rm -rf build', 'nice rm a', 'nice -n 10 rm a',
      'busybox rm a', 'timeout 5 rm a', 'sudo -n rm a', 'sudo -u www-data rm a', 'sudo env rm a', 'nohup nice /bin/rm -rf build', 'find . -name "*.tmp" | xargs -0 rm', 'ls | xargs -I {} rm {}',
      // After a variable set for that one command.
      'FOO=1 rm notes.txt', 'LC_ALL=C DEBUG="a b" rm notes.txt', 'env FOO=1 rm notes.txt', 'cd build && FOO=1 /bin/rm -rf out',
      // By a method of the thing itself.
      'python3 -c "from pathlib import Path; Path(\'a.txt\').unlink()"', 'python -c "import pathlib; pathlib.Path(\'d\').rmdir()"',
      'powershell -Command "(Get-Item a.txt).Delete()"', '$f.Delete()',
      // History thrown away on the other side.
      'git push --force', 'git push origin main --force', 'git push -f origin main', 'git push --force-with-lease origin main', 'git push origin +main',
      'git push -fu origin x', 'git push -uf origin x', 'git push -d origin old', 'git push origin :old', 'git push --mirror', 'git push --prune origin',
      'git -C repo push --force', 'git push origin "+main"', 'git push origin --delete feature', 'cd repo && git push -f', 'sudo git push -f', 'bash -c "git push --force"', '(cd repo; git push -f)', 'if ok; then git push --force; fi',
      // The word that runs what follows, named by its own path, and the two dashes that end its options.
      '/usr/bin/env rm x', 'sudo /usr/bin/env rm x', '/usr/bin/time -v rm x', 'nohup /usr/bin/env rm x', 'sudo -- rm -rf x', 'env -- rm x', 'sudo -u root -- rm x',
      'bash -c "/bin/rm -rf build"', "sh -c '/usr/local/bin/trash a'",
    ]) {
      if (!commandDeletes(command)) missed.push(command);
    }
    expect(missed).toEqual([]);
  });

  test('a command that only looks, makes or changes is not a delete', () => {
    const wrong: string[] = [];
    for (const command of [
      'ls -la', 'dir', 'echo hello', 'echo hello > out.txt', 'cat notes.txt', 'mkdir notch-test', 'New-Item -ItemType Directory x',
      'Get-ChildItem', 'Get-Process | Sort-Object WS -Descending | Select-Object -First 5', 'git status', 'git log --oneline', 'git checkout main',
      'git commit -m "remove the old page"', 'npm install', 'npm run build', 'npm run cli -- --help', 'pip install requests', 'winget install Steam',
      'docker ps', 'docker run --rm -it ubuntu', 'kubectl get pods', 'python script.py', 'node server.js', 'curl https://example.com',
      'where steam', 'Get-StartApps', 'cp a b', 'mv a b', 'copy a b', 'move a b', 'type notes.txt', 'whoami', 'hostname',
      'Clear-Host', 'cls', 'grep -r "delete" src', 'tar -xzf a.tgz', 'code .', 'explorer .', 'start notepad', 'aws cli help',
      'ffmpeg -i in.mp4 out.mp3', 'findstr /s delete *.txt', 'cmd 2>&1', 'Write-Output "the rmdir command"',
      // The same words that run something else, or that are only talked about.
      'env', 'env FOO=1 node server.js', 'FOO=1 bun test', 'time ls', 'nohup node server.js &', 'nice -n 10 make', 'timeout 5 curl https://example.com',
      'command -v rm', 'which rm', 'man rm', 'cat docs/rm', 'ls /bin/rm', 'curl "https://example.com/rm"', 'cd ~/rm && ls', 'sudo -n ls', 'busybox ls',
      'git push', 'git push origin main', 'git push -u origin feature', 'git push --follow-tags', 'git push origin fix+more', 'node -e "m.delete(1)"', 'python -c "a.remove(1)"',
      // A folder or a file that only shares a name with a program that removes.
      'grep "x" docs/rm', 'cp "a b" /backup/trash', 'du -c /home/me/.local/share/Trash', 'wc -c src/del', 'head -c 100 logs/rd', 'curl -c jar/rd https://x', '/usr/bin/ri Array',
      // A push that is only written about, and a method that is only searched for.
      'git commit -m "never git push -f here"', 'git log --grep "git push --force"', 'echo "use git push --force-with-lease"', 'grep -rn ".Delete(" src',
      'git push origin HEAD:main', 'git push --set-upstream origin dev', 'git push origin feature-f', 'git push --no-verify',
    ]) {
      if (commandDeletes(command)) wrong.push(command);
    }
    expect(wrong).toEqual([]);
    expect(commandDeletes('')).toBe(false);
    expect(commandDeletes(undefined)).toBe(false);
    expect(commandDeletes(42)).toBe(false);
  });

  test('a Delete key is a delete, in any chord', () => {
    for (const keys of ['delete', 'Delete', 'shift,delete', 'ctrl,shift,delete', 'del', 'shift+delete']) expect(keysDelete(keys)).toBe(true);
    for (const keys of ['enter', 'ctrl,s', 'backspace', 'ctrl,d', 'alt,f4', 'tab', '', 'deleted']) expect(keysDelete(keys)).toBe(false);
    expect(keysDelete(undefined)).toBe(false);
  });

  test('on a Mac the delete of a file is the command key with backspace', () => {
    const missed: string[] = [];
    for (const keys of ['cmd,backspace', 'cmd+backspace', 'Cmd+Backspace', 'command,backspace', 'cmd,option,backspace', 'cmd,shift,backspace', 'meta,backspace', 'Meta+Backspace', 'super,bs', 'cmd, backspace']) {
      if (!keysDelete(keys)) missed.push(keys);
    }
    expect(missed).toEqual([]);
    // Backspace by itself, or with a key that is not the command key, rubs out typed text.
    for (const keys of ['backspace', 'ctrl,backspace', 'alt,backspace', 'option,backspace', 'shift,backspace', 'cmd,b', 'cmd,s']) expect(keysDelete(keys)).toBe(false);
    expect(callDeletesOrPays('desktop_press_keys', { keys: 'cmd,backspace' }, ['control_app'])).toBe(true);
    // In a page the keys go to the page, where they rub out a line of text: never a file.
    expect(callDeletesOrPays('browser_press_key', { key: 'Meta+Backspace' }, ['access_browser'])).toBe(false);
    expect(keysDelete('Meta+Backspace', false)).toBe(false);
    expect(callDeletesOrPays('browser_press_key', { key: 'Delete' }, ['access_browser'])).toBe(true);
  });

  test('a very long command is read in a time that grows with its length', () => {
    const slow: string[] = [];
    for (const [name, text] of [
      ['a variable after every break', ';a='.repeat(70_000)],
      ['an option after every break', ';-a='.repeat(50_000)],
      ['an address with many parts', `curl "https://example.com/?x=1${'&a=1'.repeat(50_000)}"`],
      ['a push said over and over', 'git push '.repeat(22_000)],
      ['words that run what follows', 'sudo -a x1 '.repeat(18_000)],
      ['folders named by their path', '/usr/bin/env '.repeat(15_000)],
      ['brackets', '('.repeat(200_000)],
    ] as const) {
      const start = performance.now();
      expect(commandDeletes(text)).toBe(false);
      const took = performance.now() - start;
      if (took > 500) slow.push(`${name}: ${Math.round(took)} ms for ${text.length} letters`);
    }
    expect(slow).toEqual([]);
  });

  test('a call is a delete or a payment by its categories, its command or its keys', () => {
    expect(callDeletesOrPays('ui_act', { element_id: 3 }, ['control_app', 'make_payment'])).toBe(true);
    expect(callDeletesOrPays('ui_act', { element_id: 3 }, ['control_app', 'delete_data'])).toBe(true);
    expect(callDeletesOrPays('request_approval', {}, ['delete_data'])).toBe(true);
    expect(callDeletesOrPays('run_command', { command: 'rm -rf old' }, ['execute_command'])).toBe(true);
    expect(callDeletesOrPays('desktop_press_keys', { keys: 'shift,delete' }, ['control_app'])).toBe(true);
    // A send, an install, a settings change, a write, a click, a command that does not delete: none of them.
    expect(callDeletesOrPays('ui_act', { element_id: 3 }, ['control_app', 'send_email'])).toBe(false);
    expect(callDeletesOrPays('run_command', { command: 'winget install Steam' }, ['execute_command', 'install_software'])).toBe(false);
    expect(callDeletesOrPays('write_file', { path: 'a.txt', content: 'rm -rf /' }, ['write_data'])).toBe(false);
    expect(callDeletesOrPays('desktop_type', { text: 'rm -rf /' }, ['control_app'])).toBe(false);
    expect(callDeletesOrPays('desktop_press_keys', { keys: 'enter' }, ['control_app'])).toBe(false);
    expect(callDeletesOrPays('browser_navigate', { url: 'https://www.youtube.com' }, ['access_browser'])).toBe(false);
  });
});

describe('saying it is the approval', () => {
  test('only in a turn the owner started on the notch: anywhere else the ordinary rules decide', async () => {
    const gate = { categories: ['control_app' as const] };
    expect(await ownerWord('ui_act', { element_id: 52, action: 'click' }, gate, yes)).toBe('go');
    expect(await ownerWord('ui_act', { element_id: 52, action: 'click' }, gate, no)).toBeNull();
    expect(await ownerWord('run_command', { command: 'rm -rf x' }, { categories: ['execute_command'] }, no)).toBeNull();
  });

  test('the four things the owner was asked about and should not have been', async () => {
    // Typing a poem into Notepad, opening YouTube, a click on "LIBRARY", reading a value.
    expect(await ownerWord('ui_act', { element_id: 1, action: 'set_value', value: 'The moon lays silver' }, { categories: ['control_app'] }, yes)).toBe('go');
    expect(await ownerWord('browser_navigate', { url: 'https://www.youtube.com' }, { categories: ['access_browser'] }, yes)).toBe('go');
    expect(await ownerWord('ui_act', { element_id: 52, action: 'click' }, { categories: ['control_app'] }, yes)).toBe('go');
    expect(await ownerWord('ui_act', { element_id: 65, action: 'get_value' }, { categories: ['read_data'] }, yes)).toBe('go');
  });

  test('a delete or a payment is asked about, however it is done', async () => {
    expect(await ownerWord('ui_act', { element_id: 3 }, { categories: ['control_app', 'make_payment'] }, yes)).toBe('ask');
    expect(await ownerWord('ui_act', { element_id: 3 }, { categories: ['control_app', 'delete_data'] }, yes)).toBe('ask');
    expect(await ownerWord('run_command', { command: 'Remove-Item -Recurse old' }, { categories: ['execute_command'] }, yes)).toBe('ask');
    expect(await ownerWord('desktop_press_keys', { keys: 'delete' }, { categories: ['control_app'] }, yes)).toBe('ask');
    expect(await ownerWord('request_approval', { action_category: 'make_payment' }, { categories: ['make_payment'] }, yes)).toBe('ask');
  });

  test('a raw click is judged by what the machine says is there', async () => {
    const asked: string[] = [];
    setOwnerWordProbe(async (tool, params) => { asked.push(`${tool} ${JSON.stringify(params)}`); return params.element_id === 9 ? ['make_payment'] : params.element_id === 8 ? ['delete_data'] : ['send_email']; });
    const gate = { categories: ['control_app' as const] };
    expect(await ownerWord('desktop_click', { element_id: 9 }, gate, yes)).toBe('ask');
    expect(await ownerWord('desktop_click', { element_id: 8 }, gate, yes)).toBe('ask');
    expect(await ownerWord('desktop_click', { element_id: 7 }, gate, yes)).toBe('go');
    expect(await ownerWord('desktop_pointer', { x: 500, y: 500 }, gate, yes)).toBe('go');
    // Only a raw press is asked about, and only inside such a turn.
    expect(await ownerWord('desktop_type', { text: 'hello' }, gate, yes)).toBe('go');
    expect(await ownerWord('desktop_click', { element_id: 9 }, gate, no)).toBeNull();
    expect(asked).toHaveLength(4);
  });

  test('a machine that fails once is asked once more, and its second answer counts', async () => {
    let tries = 0;
    setOwnerWordProbe(async (_tool, params) => {
      tries += 1;
      if (tries === 1) throw new Error('describe_target timed out');
      return params.element_id === 9 ? ['make_payment'] : [];
    });
    const gate = { categories: ['control_app' as const] };
    expect(await ownerWord('desktop_click', { element_id: 9 }, gate, yes)).toBe('ask');
    expect(tries).toBe(2);
    tries = 0;
    expect(await ownerWord('desktop_click', { element_id: 7 }, gate, yes)).toBe('go');
    expect(tries).toBe(2);
  });

  test('a raw click on a screen that could not be read is asked about, never pressed blind', async () => {
    const gate = { categories: ['control_app' as const] };
    // It fails both times: an older desktop app, or a machine that does not answer in time.
    let tries = 0;
    setOwnerWordProbe(async () => { tries += 1; throw new Error('the desktop app does not know describe_target'); });
    expect(await ownerWord('desktop_click', { element_id: 9 }, gate, yes)).toBe('unseen');
    expect(tries).toBe(2);
    // It can say what is at a place and said nothing, both times (an element it no longer knows, a read that broke).
    tries = 0;
    setOwnerWordProbe(async () => { tries += 1; return null; });
    expect(await ownerWord('desktop_pointer', { x: 500, y: 500 }, gate, yes)).toBe('unseen');
    expect(tries).toBe(2);
    // Only a raw press, and only in such a turn: nothing else is held up by a screen that cannot be read.
    expect(await ownerWord('desktop_type', { text: 'hello' }, gate, yes)).toBe('go');
    expect(await ownerWord('ui_act', { element_id: 52, action: 'click' }, gate, yes)).toBe('go');
    expect(await ownerWord('desktop_click', { element_id: 9 }, gate, no)).toBeNull();
    // A delete seen in the call itself stays what it is called.
    expect(await ownerWord('desktop_click', { element_id: 9 }, { categories: ['control_app', 'delete_data'] }, yes)).toBe('ask');
  });

  test('what is asked carries its own reason', () => {
    expect(ownerWordAsks('ask')).toBe(OWNER_WORD_ASKS_REASON);
    expect(ownerWordAsks('unseen')).toBe(OWNER_WORD_UNSEEN_REASON);
    expect(ownerWordAsks('go')).toBeNull();
    expect(ownerWordAsks(null)).toBeNull();
  });

  test('a call whose own classifier failed is left to the ordinary rules: nothing is known about it', async () => {
    expect(await ownerWord('run_skill', { name: 'x' }, { categories: ['execute_command'], unclassified: true }, yes)).toBeNull();
  });
});

describe('the standing ends with the asking', () => {
  const bare = (requestId: string): BriefExecutionContext =>
    ({ conversationId: 'c', turnId: 't', requestId, signal: new AbortController().signal, progress: () => {} });

  test('a turn from the notch has it while it runs, and not once it is over or was stopped', () => {
    const before = process.env[NOTCH_SWITCH];
    process.env[NOTCH_SWITCH] = '1';
    try {
      const running = turnContext('spoken');
      expect(withBriefTurn(running, () => ownerAskedOnNotch())).toBe(true);
      // The turn ended. A timer it left behind still carries its context.
      running.over = true;
      expect(withBriefTurn(running, () => ownerAskedOnNotch())).toBe(false);
      // Esc: stopped. Nothing more goes ahead on the owner's word.
      const controller = new AbortController();
      const stopped = turnContext('typed', { controller });
      expect(withBriefTurn(stopped, () => ownerAskedOnNotch())).toBe(true);
      controller.abort();
      expect(withBriefTurn(stopped, () => ownerAskedOnNotch())).toBe(false);
      // A dashboard turn never had it.
      expect(withBriefTurn(bare('req-1'), () => ownerAskedOnNotch())).toBe(false);
      expect(ownerAskedOnNotch()).toBe(false);
      // Nor did a turn that names itself as the notch's turns are named.
      expect(withBriefTurn(bare('notch-typed-2'), () => ownerAskedOnNotch())).toBe(false);
      // Nor a turn whose words the notch wrote for the owner.
      expect(withBriefTurn(turnContext('shown'), () => ownerAskedOnNotch())).toBe(false);
    } finally {
      if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before;
    }
  });
});
