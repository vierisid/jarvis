/**
 * Opening an app is not something to ask about.
 *
 * Decided by the owner on 13 November 2026, with the operating system as the
 * measure: it does not ask "are you sure?" before it opens an app. It asks
 * before something is deleted, before money moves, and before it runs a
 * program it does not know. So, for what the owner asks on the notch with
 * their own hands, a plain app open needs no approval, and is not held back
 * by outside content read earlier in the turn.
 *
 * What a plain app open is, and it is deliberately narrow:
 *
 *   - the tool is `desktop_launch_app`;
 *   - it has no arguments. An app with arguments is a program being told
 *     what to do, which is a command by another name;
 *   - the app is named the way a person names one (a bare name the system
 *     resolves), or is a program inside the system's own folders for
 *     installed apps. A program in Downloads or a temporary folder is one the
 *     system itself would ask about;
 *   - it is not a shell, a script host, an installer or a system tool that
 *     does something by merely being started.
 *
 * Everything else about the call is unchanged. Its result is still outside
 * content (a window title is the page's own text), so what the turn does
 * AFTER it is still watched (authority/taint-gating.ts).
 *
 * Where it applies: only inside a turn the owner started on the notch, and
 * only with the notch switch on. Everywhere else `desktop_launch_app` is
 * reviewed on screen as before (authority/ui-intent.ts).
 */
import { currentBriefTurn } from '../brief/chat-context.ts';
import { notchEnabled } from '../notch/switch.ts';

/** How the request id of a turn started on the notch begins (src/notch/asks.ts). */
export const NOTCH_REQUEST_ID = /^notch-(typed|spoken)-/;

/**
 * Whether the code running now is inside a turn the owner started on the
 * notch, and that turn is still going. Once it has ended or been stopped
 * (Esc), whatever it left running has no standing from it.
 */
export function ownerAskedOnNotch(): boolean {
  if (!notchEnabled()) return false;
  const turn = currentBriefTurn();
  return !!turn && NOTCH_REQUEST_ID.test(turn.requestId) && turn.over !== true && !turn.signal.aborted;
}

/**
 * Programs that are not "an app" however they are named: shells and script
 * hosts (they run whatever they are handed next), installers, and tools that
 * act by being started.
 */
const NOT_AN_APP: ReadonlySet<string> = new Set([
  'cmd', 'command', 'powershell', 'powershell_ise', 'pwsh', 'wt', 'windowsterminal', 'conhost', 'openconsole',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'wsl', 'wslhost', 'ubuntu', 'debian',
  'terminal', 'iterm', 'iterm2', 'xterm', 'gnome-terminal', 'konsole', 'alacritty', 'kitty', 'warp', 'hyper', 'tmux', 'screen',
  'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'installutil', 'regasm', 'regsvcs', 'msbuild', 'odbcconf',
  'python', 'python3', 'pythonw', 'py', 'node', 'nodejs', 'bun', 'deno', 'perl', 'ruby', 'php', 'java', 'javaw', 'lua', 'osascript', 'automator',
  'reg', 'regedit', 'regedt32', 'schtasks', 'at', 'sc', 'net', 'net1', 'netsh', 'format', 'diskpart', 'bcdedit', 'cipher', 'wevtutil',
  'vssadmin', 'wbadmin', 'shutdown', 'logoff', 'tsdiscon', 'taskkill', 'tskill', 'takeown', 'icacls', 'attrib', 'sdelete', 'fsutil', 'mountvol',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'certutil', 'bitsadmin', 'sudo', 'su', 'runas', 'doas', 'pkexec',
  'reboot', 'poweroff', 'halt', 'init', 'telinit', 'pm-suspend', 'loginctl', 'pmset', 'caffeinate', 'rundll', 'slui', 'rstrui',
  'open', 'start', 'xdg-open', 'launchctl', 'systemctl', 'service', 'kill', 'killall', 'pkill', 'rm', 'del', 'rd', 'rmdir', 'erase', 'mv', 'move', 'cp', 'copy', 'dd',
]);

/**
 * The same, by the names the Start menu shows them under: the desktop app
 * finds an app by that name too (sidecar/desktop_startmenu.go), so "Command
 * Prompt" must not pass where `cmd` does not. A name that says it uninstalls,
 * installs, repairs or resets something is not an app to open either.
 */
const NOT_AN_APP_BY_NAME = new RegExp([
  '\\b(command prompt|powershell|terminal|console|git bash|git cmd|bash|shell|wsl|ubuntu|debian)\\b',
  '\\b(registry editor|task scheduler|services|computer management|disk management|disk cleanup|event viewer)\\b',
  '\\b(group policy|local security policy|system configuration|system restore|recovery|device manager|run)\\b',
  '\\b(un-?install\\w*|install\\w*|setup|remove|repair|reset|updater?|maintenance tool)\\b',
].join('|'), 'i');

/** What ends a file that is not a program to open but a script or an installer to run. */
const NOT_AN_APP_ENDING = /\.(bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|pif|cpl|lnk|url|reg|jar|sh|command|py|pl|rb)$/i;

const bareName = (value: string): string => value.toLowerCase().replace(/\.(exe|app)$/, '').trim();

/**
 * A name a person would call an app by: letters, digits, spaces, and a dot,
 * underscore, plus or hyphen. No path, no address (a colon or a slash would
 * make it a link the system opens), nothing a shell reads.
 */
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+-]{0,79}$/u;

/** Where installed apps live. Anything outside these is a program from somewhere. */
const WINDOWS_APP_FOLDER = /^[a-z]:\\program files( \(x86\))?\\/i;
const MAC_APP = /^\/(system\/)?applications\/.+\.app\/?$/i;

function lastPart(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Whether a call's arguments are a plain app open, as written above. */
export function plainAppOpen(toolName: string, params: Record<string, unknown>): boolean {
  if (toolName !== 'desktop_launch_app') return false;
  const args = params.args;
  if (args !== undefined && args !== null && !(typeof args === 'string' && args.trim() === '')) return false;
  const raw = params.executable;
  if (typeof raw !== 'string') return false;
  // Windows drops dots and spaces from the end of a name, so "logoff.exe."
  // is logoff: a name that ends in one is not taken as written.
  if (/[.\s]$/.test(raw) || /^\s/.test(raw)) return false;
  const executable = raw;
  if (!executable || executable.length > 260 || /[\r\n\t"<>|*?%$`;]/.test(executable)) return false;
  if (NOT_AN_APP_ENDING.test(executable)) return false;
  if (/[\\/]/.test(executable)) {
    // A path: only into the system's own folders for installed apps, and never upward out of them.
    if (/(^|[\\/])\.\.([\\/]|$)/.test(executable)) return false;
    const program = bareName(lastPart(executable));
    if (NOT_AN_APP.has(program) || NOT_AN_APP_BY_NAME.test(program)) return false;
    if (MAC_APP.test(executable)) return true;
    return WINDOWS_APP_FOLDER.test(executable) && /\.exe$/i.test(executable);
  }
  return APP_NAME.test(executable) && !NOT_AN_APP.has(bareName(executable)) && !NOT_AN_APP_BY_NAME.test(executable);
}

/** A plain app open, in a turn the owner started on the notch: the one case that needs no approval. */
export function appOpenNeedsNoApproval(toolName: string, params: Record<string, unknown>): boolean {
  return plainAppOpen(toolName, params) && ownerAskedOnNotch();
}
