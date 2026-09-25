/**
 * The toast script and the notify-send argv carry workflow- and model-authored
 * text. #515: the PowerShell toast put that text inside a single-quoted literal
 * and escaped only ASCII `'`, so a typographic quote, or a truncation that
 * split a doubled `''`, let the text run as PowerShell.
 */
import { describe, expect, test } from 'bun:test';
import {
  TOAST_BODY_MAX,
  TOAST_TITLE_MAX,
  buildNotifySendArgs,
  buildPowerShellToastScript,
} from './desktop-notify.ts';

const BASE64_LITERAL = /FromBase64String\('([^']*)'\)/g;

/** The two decoded strings, in script order (title, body). */
function decodedTexts(script: string): string[] {
  return [...script.matchAll(BASE64_LITERAL)].map(m => Buffer.from(m[1]!, 'base64').toString('utf8'));
}

/** The script with its two base64 payloads blanked: what the text cannot change. */
function skeleton(script: string): string {
  return script.replace(BASE64_LITERAL, "FromBase64String('')");
}

const HOSTILE = [
  "it's'; Remove-Item C:\\ -Recurse; '",
  '\u2018; calc.exe; \u2018',
  '\u2019; calc.exe; \u2019',
  '\u201A; calc.exe; \u201A',
  '\u201B; calc.exe; \u201B',
  '$(Start-Process calc.exe)',
  '`$env:USERPROFILE` and `n',
  'a; b; c',
  'line one\nline two\r\n"; calc.exe',
  '<text id="3">injected</text>',
  'Tom & Jerry &amp; &#x41;',
  ']]><script/><![CDATA[',
  '"double" and \'single\' and \u201Csmart\u201D \u201Elow\u201D',
  "here-string ends\n'@\n\"@\nNew-Item pwned",
];

describe('buildPowerShellToastScript', () => {
  const fixed = skeleton(buildPowerShellToastScript('', ''));

  test.each(HOSTILE)('hostile text never reaches the script as source: %p', text => {
    const script = buildPowerShellToastScript(text, text);
    // Everything outside the two base64 literals is the same fixed script
    // whatever the text is, and the literals hold only base64 characters.
    expect(skeleton(script)).toBe(fixed);
    for (const m of script.matchAll(BASE64_LITERAL)) expect(m[1]).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(script).not.toContain(text);
    expect(decodedTexts(script)).toEqual([text, text]);
  });

  test('the text goes into the stock template as DOM text nodes; no XML is parsed', () => {
    const script = buildPowerShellToastScript(']]><x/>', '<text id="3"/>&');
    expect(script).not.toContain('LoadXml');
    expect(script).toContain('GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)');
    expect(script).toContain('$text.Item(0).AppendChild($xml.CreateTextNode($title))');
    expect(script).toContain('$text.Item(1).AppendChild($xml.CreateTextNode($body))');
  });

  test('the script has no double quote for a Windows command-line layer to mangle', () => {
    for (const text of HOSTILE) expect(buildPowerShellToastScript(text, text)).not.toContain('"');
  });

  test.each([
    ["'"], ['\u2018'], ['\u2019'], ['\u201A'], ['\u201B'],
  ])('a quote at the truncation boundary is cut as raw text, not as an escape: %p', quote => {
    // 99 characters then the quote lands the quote exactly at the cap; the old
    // escape-then-slice turned `'` into `''` and cut it to a lone `'`.
    const title = 'a'.repeat(TOAST_TITLE_MAX - 1) + quote + '; calc.exe';
    const body = 'b'.repeat(TOAST_BODY_MAX - 1) + quote + '; calc.exe';
    const script = buildPowerShellToastScript(title, body);
    expect(skeleton(script)).toBe(fixed);
    expect(decodedTexts(script)).toEqual([
      'a'.repeat(TOAST_TITLE_MAX - 1) + quote,
      'b'.repeat(TOAST_BODY_MAX - 1) + quote,
    ]);
  });

  test('huge text is capped, so the command line stays far under the Windows limit', () => {
    const huge = '\u{1F389}'.repeat(100_000);
    expect(buildPowerShellToastScript(huge, huge).length).toBeLessThan(4_000);
  });

  test('ordinary text, Unicode and emoji survive unchanged', () => {
    const title = 'JARVIS: Caf\u00e9 \u2615 \u65e5\u672c\u8a9e';
    const body = 'Build done \u{1F389} in 3.2s \u2014 \u00fcber \u{1F468}\u200D\u{1F4BB}\nnext line\tand a tab';
    expect(decodedTexts(buildPowerShellToastScript(title, body))).toEqual([title, body]);
  });

  test('truncation counts code points, so an emoji at the cap is never split', () => {
    const title = 'a'.repeat(TOAST_TITLE_MAX - 1) + '\u{1F389}' + 'tail';
    const [decoded] = decodedTexts(buildPowerShellToastScript(title, ''));
    expect(decoded).toBe('a'.repeat(TOAST_TITLE_MAX - 1) + '\u{1F389}');
    expect(decoded).not.toContain('\uFFFD');
  });

  test('a lone surrogate in the input becomes U+FFFD rather than invalid UTF-8', () => {
    expect(decodedTexts(buildPowerShellToastScript('a\uD83Cb', ''))[0]).toBe('a\uFFFDb');
  });

  test('control characters XML cannot carry are dropped; tab and newlines are kept', () => {
    const [title, body] = decodedTexts(buildPowerShellToastScript('a\u0000b\u0007c\u001Bd', 'x\ty\nz\r\u000B\uFFFF'));
    expect(title).toBe('abcd');
    expect(body).toBe('x\ty\nz\r');
  });
});

describe('buildNotifySendArgs', () => {
  test('title and body are positional after `--`, even when they look like options', () => {
    const args = buildNotifySendArgs('-u', '--icon=/etc/passwd', { urgency: 'critical' });
    expect(args.slice(-3)).toEqual(['--', '-u', '--icon=/etc/passwd']);
    expect(args.indexOf('--')).toBe(args.length - 3);
  });

  test('NUL is dropped, since Bun refuses to spawn an argument containing one', () => {
    expect(buildNotifySendArgs('a\u0000b', '\u0000c').slice(-2)).toEqual(['ab', 'c']);
  });

  test('urgency and expiry defaults are unchanged', () => {
    expect(buildNotifySendArgs('T', 'B')).toEqual([
      'notify-send', '--urgency=normal', '--expire-time=5000', '--app-name=JARVIS', '--', 'T', 'B',
    ]);
    expect(buildNotifySendArgs('T', 'B', { urgency: 'critical' })).toContain('--expire-time=10000');
  });
});

// ── Parse and decode it with a real PowerShell when one is installed ──
//
// pwsh has the same tokenizer as Windows PowerShell 5.1 -- it too closes a
// single-quoted literal on U+2018..U+201B -- but no WinRT, so the script
// cannot run to the end here. Instead: parse it without running it and check
// that the text caused no parse error and added no command (a .NET call would
// not show there; the skeleton check above covers that), and run only the
// decode lines to check the round trip. pwsh is preinstalled on GitHub's
// ubuntu runners.

const PWSH = Bun.which('pwsh');

describe.skipIf(!PWSH)('toast script under a real PowerShell', () => {
  /** The pre-#515 builder, verbatim, as a positive control for the payloads. */
  function legacyScript(title: string, body: string): string {
    const safeTitle = title.replace(/'/g, "''").slice(0, 100);
    const safeBody = body.replace(/'/g, "''").slice(0, 200);
    return `
    $ErrorActionPreference = 'Stop'
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
    $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
    $xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">${safeTitle}</text><text id="2">${safeBody}</text></binding></visual></toast>')
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('JARVIS').Show($toast)
  `.trim();
  }

  function pwsh(script: string): { code: number | null; out: string; err: string } {
    const r = Bun.spawnSync([PWSH!, '-NoProfile', '-NonInteractive', '-Command', script], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  /** Parse `script` without running it: its parse errors and every command it names. */
  function parse(script: string): { errors: string[]; commands: string[] } {
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    const r = pwsh(`
      $s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
      $errs = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$null, [ref]$errs)
      $cmds = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
      ConvertTo-Json -Compress @{ errors = @($errs | ForEach-Object Message); commands = @($cmds | ForEach-Object { $_.GetCommandName() }) }
    `);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    return JSON.parse(r.out);
  }

  // Close the literal and the LoadXml call, run a command, then reopen a
  // parenthesised literal for the script's own trailing `')`.
  const TYPOGRAPHIC = ['\u2018', '\u2019', '\u201A', '\u201B'];
  const payload = (q: string) => `${q}); New-Item pwned; (${q}`;
  const FIXED_COMMANDS = ['Out-Null', 'Out-Null', 'Out-Null', 'Out-Null'];

  test('the new script, with empty text, parses to its fixed commands', () => {
    expect(parse(buildPowerShellToastScript('', ''))).toEqual({ errors: [], commands: FIXED_COMMANDS });
  }, 30_000);

  test.each(TYPOGRAPHIC)('the legacy escaping lets a payload closed by %p add a command (the payloads are live)', q => {
    expect(parse(legacyScript(payload(q), 'body'))).toEqual({ errors: [], commands: ['Out-Null', 'Out-Null', 'New-Item'] });
  }, 30_000);

  test.each([...TYPOGRAPHIC, "'"])('the new script adds no command for a payload closed by %p', q => {
    expect(parse(buildPowerShellToastScript(payload(q), payload(q)))).toEqual({ errors: [], commands: FIXED_COMMANDS });
  }, 30_000);

  test("a quote at the title cap broke the legacy script's parse, and no longer does", () => {
    const title = 'x'.repeat(TOAST_TITLE_MAX - 1) + "'";
    const body = "'); New-Item pwned; ('";
    expect(parse(legacyScript(title, body)).errors).not.toEqual([]);
    expect(parse(buildPowerShellToastScript(title, body))).toEqual({ errors: [], commands: FIXED_COMMANDS });
  }, 30_000);

  const ROUND_TRIP = [
    ...HOSTILE,
    ...["'", '\u2018', '\u2019', '\u201A', '\u201B'].map(q => 'a'.repeat(TOAST_TITLE_MAX - 1) + q),
  ];

  test.each(ROUND_TRIP)('PowerShell decodes exactly the text that was sent: %p', text => {
    // Only the lines that handle the text, run as generated, then report what
    // PowerShell holds -- as base64 so the console encoding cannot interfere.
    const script = buildPowerShellToastScript(text, `${text} \u{1F389}`);
    const decodeLines = script.split('\n').filter(l => /^\s*\$(ErrorActionPreference|title|body) =/.test(l));
    expect(decodeLines).toHaveLength(3);
    const r = pwsh(
      `${decodeLines.join('\n')}\n[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($title + [char]0 + $body))`,
    );
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(Buffer.from(r.out.trim(), 'base64').toString('utf8')).toBe(`${text}\u0000${text} \u{1F389}`);
  }, 30_000);
});
