/**
 * Guards the `[POINT:..]` coordinate-space contract (#604).
 *
 * The defect this file exists for was not a typo. One sentence told the model
 * its coordinates were "virtual-screen pixels" while the paragraph four lines
 * below told it to use the attached screenshot's pixel grid, and the mistake
 * list below THAT named emitting screen coordinates as the first thing to
 * avoid. The section contradicted itself, the claim was true on one of three
 * platforms, and nothing downstream of the model could tell.
 *
 * So the assertions are about WHICH SPACE IS NAMED WHERE and about
 * self-consistency, not byte counts. A ceiling alone would have passed on the
 * broken text the day it shipped: that sentence was already short and already
 * ASCII-clean.
 *
 * Two properties here are not about the text at all, and they are the ones a
 * reword is most likely to break silently: that the prompt is still WIRED IN
 * (extracting it created a way to delete the whole contract with every test
 * green), and that the regex the daemon strips tags with still matches the tag
 * this text teaches.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  logSafeLabel, MAX_POINT_COORD, PEBBLE_SCREEN_SPACE, POINT_TAG_PATTERN,
  pointingGuidance, pointTagRegex, type PointerOs,
} from './pebble-point-prompt.ts';

const ALL_OS: PointerOs[] = ['macos', 'windows', 'linux', null];

/** The guidance for an unknown OS, which is the branch that names all three. */
const generic = pointingGuidance(null);
const text = generic.join('\n');

/** Find one line by a stable fragment, failing readably when it is reworded. */
function line(lines: readonly string[], needle: string): string {
  const found = lines.find((l) => l.includes(needle));
  // Named explicitly: a bare find(...)! gives "cannot read properties of
  // undefined" on a reword, which says nothing about what moved.
  expect(found, `no guidance line contains "${needle}"`).toBeDefined();
  return found!;
}

describe('#604 the contract names one space per case', () => {
  test('it never promises a virtual-screen space, on any OS', () => {
    // The exact wrong claim. True on Windows only: the value reaches the
    // pebble in platformGetCursorPos() space, which is Cocoa points on macOS
    // and GDK logical pixels on Linux.
    for (const os of ALL_OS) {
      expect(pointingGuidance(os).join('\n')).not.toMatch(/virtual[- ]screen/i);
    }
  });

  test('it states three cases, not two', () => {
    // Two cases was the bug after the first correction: an image IS attached
    // on the T19 region path, but `pointScaleX` follows `autoShot`, so a crop
    // gets neither a scale nor an origin. A two-case rule sends the model
    // confidently into the wrong frame there.
    const rule = line(generic, 'Which space to write coordinates in');
    expect(rule).toContain('Three cases');
    expect(line(generic, 'A screenshot WITH the labelled coordinate grid')).toBeTruthy();
    expect(line(generic, 'No image at all')).toBeTruthy();
    expect(line(generic, 'An image WITHOUT that grid')).toBeTruthy();
  });

  test('the ungridded-image case refuses rather than guesses', () => {
    // The fail-closed branch, and the reason it is correct: nothing records
    // where a region crop sat on screen, so no frame the model picks is right.
    // #585's trade -- say so instead of pointing confidently wrong.
    const case3 = line(generic, 'An image WITHOUT that grid');
    expect(case3).toContain('CANNOT place a pointer');
    expect(case3).toContain('do NOT emit a [POINT:..] tag');
    // And the REQUIRED rule must carve it out, or the two instructions fight.
    expect(line(generic, 'Required for any request matching')).toContain('case 3');
  });

  test('case 1 keys on the grid, which is what tracks the rescale', () => {
    // `grid := compact` in sidecar/handlers.go, and the same `compact` branch
    // is what shrinks the image and so what makes orig/sent differ from 1.
    // "Carries the grid" and "was rescaled" are therefore the same question --
    // that equivalence is the whole reason this is safe to key on.
    expect(line(generic, 'A screenshot WITH the labelled coordinate grid'))
      .toContain('rescales them for you');
    expect(line(generic, 'Outputting screen coordinates')).toContain('gridded screenshot');
  });

  test('the no-image case names the unit for the OS when it is known', () => {
    // This is the branch dispatched UNSCALED, so the unit matters most here.
    expect(line(pointingGuidance('macos'), 'No image at all')).toContain('logical points');
    expect(line(pointingGuidance('linux'), 'No image at all')).toContain('logical pixels');
    expect(line(pointingGuidance('windows'), 'No image at all')).toContain('physical pixels');
    // macOS is the one with a trap worth spelling out.
    expect(line(pointingGuidance('macos'), 'No image at all')).toContain('NOT backing pixels');
  });

  test('an unknown OS names all three rather than guessing one', () => {
    // Real case: an offline or older sidecar reports no usable `os`. Guessing
    // would be a pointer off by the display scale.
    const bare = line(generic, 'No image at all');
    expect(bare).toContain('logical points on macOS');
    expect(bare).toContain('logical pixels on Linux');
    expect(bare).toContain('physical pixels on Windows');
  });

  test('nothing contradicts the daemon about who converts', () => {
    const grid = line(generic, 'Read it off the grid');
    expect(grid).toContain("into the user's screen space");
    expect(grid).not.toMatch(/real-screen pixels/i);
  });

  test('the worked example is labelled as the no-image branch and keeps its hedges', () => {
    const est = line(generic, 'Estimating coordinates');
    expect(est).toContain('WITH NO IMAGE ATTACHED');
    // "units", not "pixels": 1920x1080 must not read as a real pixel size. It
    // is also the hardcoded platformGetScreenSize stub on macOS and Linux.
    expect(est).toContain('1920 units wide');
    expect(est).not.toMatch(/1920 ?x ?1080/);
    // Approximations must not read as assertions in text whose failure mode is
    // confident wrongness.
    expect(est).toContain('typically');
    expect(est).toContain('usually');
  });
});

describe('#604 the contract stays model-safe', () => {
  test('it is plain ASCII on every OS branch', () => {
    // Model-facing text, and the file it came out of is NOT ASCII-clean, so
    // this is pinned rather than assumed. (src/daemon/index.ts still holds
    // hundreds of non-ASCII characters elsewhere; out of scope here.)
    for (const os of ALL_OS) {
      for (const l of pointingGuidance(os)) expect(l).toMatch(/^[\x00-\x7F]*$/);
    }
  });

  test('the tag it teaches is the tag the daemon strips', () => {
    // NOT a tautology: the pattern is imported from the module the daemon
    // builds POINT_TAG_RE from, and it is run over tags found IN the text. A
    // reword that taught a different shape would strip nothing and leak the
    // tag into the bubble and the spoken reply.
    const concrete = [...text.matchAll(pointTagRegex())];
    expect(concrete.length).toBeGreaterThan(0);
    for (const m of concrete) {
      expect(Number.isInteger(Number(m[1]))).toBe(true);
      expect(Number.isInteger(Number(m[2]))).toBe(true);
      expect(m[3]!.length).toBeGreaterThan(0);
    }
    // The placeholder form must survive too -- it is what the model copies.
    expect(text).toContain('[POINT:<x>,<y>:<short label>]');
  });

  test('a fresh regex per call, because /g carries lastIndex', () => {
    const a = pointTagRegex();
    expect(a).not.toBe(pointTagRegex());
    a.exec('[POINT:1,2:x]');
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(pointTagRegex().lastIndex).toBe(0);
  });

  test('it keeps the directives that make the pebble move at all', () => {
    for (const needle of [
      'REQUIRED', 'Emit ONE point per request', 'Each request is independent',
      'where is X', 'strips these tags', 'never shown',
    ]) {
      expect(text).toContain(needle);
    }
  });
});

describe('#604 every sentence about reading an image is gated on case 1', () => {
  // The structural rule, enforced rather than eyeballed. The first correction
  // left two sentences unconditioned, and they were the longest and most
  // concrete in the section -- so on the region-crop path, where an image IS
  // attached, they read as the operative instruction and pulled against the
  // case-3 refusal four lines above them.
  for (const os of ALL_OS) {
    test(`no unqualified "read it off the image" instruction (os=${os})`, () => {
      const lines = pointingGuidance(os);
      const instructs = lines.filter((l) =>
        /use the actual pixels|coordinates in the \*image\*|image-space coordinates/i.test(l));
      expect(instructs.length).toBeGreaterThan(0);
      for (const l of instructs) {
        // Must name the gate: either "case 1" or the grid that defines it.
        expect(/case 1|grid/i.test(l), `ungated image instruction: ${l.slice(0, 90)}`).toBe(true);
      }
    });
  }

  test('the daemon-converts promise is scoped, not absolute', () => {
    const grid = line(generic, 'Read it off the grid');
    expect(grid).toMatch(/In case 1 the daemon converts/i);
    // And it must say what happens in the case where it cannot.
    expect(grid).toMatch(/case 3 it does not and cannot/i);
  });
});

describe('#604 the model-authored coordinate is bounded and the label is tamed', () => {
  test('the bound matches the sidecar-measured path', () => {
    // A matched pair with maxElementPointCoord / MAX_ELEMENT_POINT_COORD. The
    // model-authored coordinate was the only one of the two left unbounded,
    // and it is the less trustworthy.
    expect(MAX_POINT_COORD).toBe(1 << 20);
  });

  test('the daemon enforces the bound before dispatch', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(src).toContain('MAX_POINT_COORD');
    expect(src).toContain('dropped out-of-range POINT');
  });

  test('an absurd coordinate still MATCHES, so it is stripped before it can leak', () => {
    // Deliberate: narrowing the digits would stop the tag matching, and a tag
    // that does not match is not stripped -- it leaks verbatim into the bubble
    // and the spoken reply. Match greedily, refuse at dispatch.
    const m = pointTagRegex().exec('[POINT:99999999999999999999999,1:x]');
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]))).toBeGreaterThan(MAX_POINT_COORD);
  });

  test('a label cannot span newlines, so a tag cannot swallow the reply', () => {
    // `[^\]]+` spanned newlines and would have eaten a paragraph of real reply
    // text out of display and TTS on a tag that only looked unclosed.
    expect(pointTagRegex().exec('[POINT:1,2:close]')).not.toBeNull();
    expect(pointTagRegex().exec('[POINT:1,2:lab\nel]')).toBeNull();
    // And it is length-bounded, so a runaway label cannot do it either.
    expect(pointTagRegex().exec(`[POINT:1,2:${'x'.repeat(121)}]`)).toBeNull();
    expect(pointTagRegex().exec(`[POINT:1,2:${'x'.repeat(120)}]`)).not.toBeNull();
  });

  test('logSafeLabel neutralises control characters and bounds length', () => {
    // The dispatch log line is the audit record for a misplaced pebble, so a
    // label that can forge a second line defeats the only thing it is for.
    expect(logSafeLabel('ok')).toBe('ok');
    expect(logSafeLabel('a\r\n[ambient-ui] forged')).toBe('a [ambient-ui] forged');
    expect(logSafeLabel('a\u0000b')).toBe('a b');
    expect(logSafeLabel('x'.repeat(100))).toHaveLength(60);
    expect(logSafeLabel('x'.repeat(100)).endsWith('...')).toBe(true);
  });

  test('the daemon logs the label through logSafeLabel, never raw', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    // Every POINT log line that carries a label must neutralise it.
    const labelLogs = src.split('\n').filter((l) =>
      /\[ambient-ui\]/.test(l) && /label="/.test(l));
    expect(labelLogs.length).toBeGreaterThan(0);
    for (const l of labelLogs) {
      expect(l, `raw label in a log line: ${l.trim().slice(0, 80)}`).toContain('logSafeLabel(');
    }
  });
});

describe('#604 an unplaceable frame is refused by the daemon, not just the prompt', () => {
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  test('the daemon computes placeability and drops the tag', () => {
    // The prompt asks; this enforces. A region crop reaches the model as an
    // ordinary first-content-block image, so case 3 cannot be left to
    // instruction-following alone.
    expect(src).toContain('placeableFrame');
    expect(src).toContain('dropped POINT in an unplaceable frame');
  });

  test('placeability is derived from the capture, not from whether an image exists', () => {
    // `!!autoShot` is the whole point: `opts.image` is an image with no scale
    // and no origin, so "an image is attached" is NOT evidence of placeability.
    expect(src).toMatch(/const placeableFrame = !!autoShot/);
  });

  test('the drop leaves the reply to answer, and says why that is enough', () => {
    // Deliberately NOT routed through `unplacedLabel`. That exists for the
    // tool-narration path, where a confident label would otherwise stand over
    // a pebble that never moved. Here the tag is stripped and the surrounding
    // text is still spoken, so the user gets the location in words -- which is
    // what case 3 asks for -- and touching pebble state mid-stream would fight
    // the speaking state machine for nothing.
    const drop = src.slice(src.indexOf('dropped POINT in an unplaceable frame'), );
    const body = drop.slice(0, 700);
    expect(body).toContain('the reply itself is the answer');
    expect(body).not.toContain('setState(');
  });
});

describe('#604 the contract is wired in and the space is defined once', () => {
  const indexSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  test('the daemon actually spreads the guidance into the prompt', () => {
    // Extracting the text created a failure mode that did not exist before:
    // delete the call site and every other test here stays green while the
    // pebble loses the whole pointing contract.
    expect(indexSrc).toContain('pointingGuidance(pebbleOs)');
    expect(indexSrc).toContain('sections.push(...pointingGuidance(');
  });

  test('the daemon builds its tag matcher from the shared pattern', () => {
    expect(indexSrc).toContain('pointTagRegex()');
    // The old inline literal must be gone, or the two can drift again.
    expect(indexSrc).not.toContain('/\\[POINT:(-?\\d+),(-?\\d+):([^\\]]+)\\]/g');
  });

  test('the sink space has a name and the dispatch log cites it', () => {
    expect(PEBBLE_SCREEN_SPACE).toBe('pebble_screen');
    expect(indexSrc).toContain('${PEBBLE_SCREEN_SPACE}');
  });

  test('the space definition records all three platforms and both caveats', () => {
    // The value is a bare string, so nothing else can assert that the
    // per-platform table travelled with it.
    const src = readFileSync(new URL('./pebble-point-prompt.ts', import.meta.url), 'utf8');
    for (const needle of [
      'Cocoa POINTS', 'GDK LOGICAL pixels', 'PerMonitorV2',
      'NEGATIVE coordinates', 'screen_dip', 'NOT A WIRE TOKEN',
    ]) {
      expect(src).toContain(needle);
    }
  });
});
