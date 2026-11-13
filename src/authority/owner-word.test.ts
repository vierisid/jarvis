import { afterEach, describe, expect, test } from 'bun:test';
import { STILL_ASKED, callDeletesOrPays, commandDeletes, keysDelete, ownerWord, setOwnerWordProbe } from './owner-word.ts';
import { ownerAskedOnNotch } from './app-open.ts';
import { withBriefTurn, type BriefExecutionContext } from '../brief/chat-context.ts';
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

  test('a machine that cannot say is not a reason to ask', async () => {
    setOwnerWordProbe(async () => { throw new Error('the desktop app does not know describe_target'); });
    expect(await ownerWord('desktop_click', { element_id: 9 }, { categories: ['control_app'] }, yes)).toBe('go');
  });

  test('a call whose own classifier failed is left to the ordinary rules: nothing is known about it', async () => {
    expect(await ownerWord('run_skill', { name: 'x' }, { categories: ['execute_command'], unclassified: true }, yes)).toBeNull();
  });
});

describe('the standing ends with the asking', () => {
  const context = (requestId: string, controller = new AbortController()): BriefExecutionContext =>
    ({ conversationId: 'c', turnId: 't', requestId, signal: controller.signal, progress: () => {} });

  test('a turn from the notch has it while it runs, and not once it is over or was stopped', () => {
    const before = process.env[NOTCH_SWITCH];
    process.env[NOTCH_SWITCH] = '1';
    try {
      const running = context('notch-spoken-1');
      expect(withBriefTurn(running, () => ownerAskedOnNotch())).toBe(true);
      // The turn ended. A timer it left behind still carries its context.
      running.over = true;
      expect(withBriefTurn(running, () => ownerAskedOnNotch())).toBe(false);
      // Esc: stopped. Nothing more goes ahead on the owner's word.
      const controller = new AbortController();
      const stopped = context('notch-typed-2', controller);
      expect(withBriefTurn(stopped, () => ownerAskedOnNotch())).toBe(true);
      controller.abort();
      expect(withBriefTurn(stopped, () => ownerAskedOnNotch())).toBe(false);
      // A dashboard turn never had it.
      expect(withBriefTurn(context('req-1'), () => ownerAskedOnNotch())).toBe(false);
      expect(ownerAskedOnNotch()).toBe(false);
    } finally {
      if (before === undefined) delete process.env[NOTCH_SWITCH]; else process.env[NOTCH_SWITCH] = before;
    }
  });
});
