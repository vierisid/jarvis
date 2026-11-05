import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
  buildSsml,
  edgeSynthesize,
  edgeVoiceName,
  escapeSsmlText,
  EDGE_UNAVAILABLE_MESSAGE,
  EDGE_UNREACHABLE_MESSAGE,
  EdgeTTSError,
  edgeTtsStatus,
  parseBinaryMessage,
  resetClockSkew,
  resetEdgeTtsStatus,
  secMsGec,
  splitEscapedText,
  type EdgeSynthesisOptions,
} from './edge-tts-client.ts';

const PROSODY = { voice: 'en-US-AriaNeural', rate: '+0%', volume: '+0%', pitch: '+0Hz' };

/** A binary audio message as the service frames it. */
function audioFrame(requestId: string, payload: Uint8Array | string): Uint8Array {
  const header = new TextEncoder().encode(
    `X-RequestId:${requestId}\r\nContent-Type:audio/mpeg\r\nX-StreamId:S\r\nPath:audio\r\n`,
  );
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(2 + header.length + body.length);
  out[0] = header.length >> 8;
  out[1] = header.length & 0xff;
  out.set(header, 2);
  out.set(body, 2 + header.length);
  return out;
}

function textFrame(requestId: string, path: string, body = '{}'): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/json; charset=utf-8\r\nPath:${path}\r\n\r\n${body}`;
}

interface Turn { ws: ServerWebSocket<unknown>; requestId: string; ssml: string }
type Behaviour = (turn: Turn) => void;

/** One upgrade the fake service saw. */
interface Seen { url: URL; headers: Headers; messages: string[]; closed: Promise<number> }

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => { server?.stop(true); server = null; resetClockSkew(); resetEdgeTtsStatus(); });

/**
 * A local stand-in for the service. `behave` answers each SSML request;
 * `refuse` rejects the handshake with that status.
 */
function fakeService(
  behave: Behaviour,
  refuse?: number | ((url: URL) => number | undefined),
  serverDate?: () => string,
) {
  const seen: Seen[] = [];
  const byWs = new Map<ServerWebSocket<unknown>, { seen: Seen; onClose: (c: number) => void }>();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      let onClose!: (c: number) => void;
      const entry: Seen = {
        url: new URL(req.url),
        headers: req.headers,
        messages: [],
        closed: new Promise<number>((r) => { onClose = r; }),
      };
      if (req.method === 'HEAD') {
        return new Response(null, { status: 403, headers: serverDate ? { Date: serverDate() } : {} });
      }
      seen.push(entry);
      const status = typeof refuse === 'function' ? refuse(entry.url) : refuse;
      if (status) return new Response('', { status });
      if (srv.upgrade(req, { data: { entry, onClose } })) return undefined;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        const d = ws.data as { entry: Seen; onClose: (c: number) => void };
        byWs.set(ws, { seen: d.entry, onClose: d.onClose });
      },
      message(ws, msg) {
        const text = typeof msg === 'string' ? msg : '<binary>';
        const e = byWs.get(ws)!;
        e.seen.messages.push(text);
        if (!text.includes('Path:ssml')) return;
        const requestId = /X-RequestId:([^\r]*)/.exec(text)![1]!;
        behave({ ws, requestId, ssml: text.slice(text.indexOf('\r\n\r\n') + 4) });
      },
      close(ws, code) { byWs.get(ws)?.onClose(code); },
    },
  });
  const opts = (extra: Partial<EdgeSynthesisOptions> = {}): EdgeSynthesisOptions => ({
    ...PROSODY,
    timeoutMs: 5000,
    endpoint: `ws://127.0.0.1:${server!.port}/edge/v1`,
    ...extra,
  });
  return { seen, opts };
}

/** The normal answer: start, three audio frames with metadata between, end. */
const speaks: Behaviour = ({ ws, requestId }) => {
  ws.send(textFrame(requestId, 'turn.start'));
  ws.send(textFrame(requestId, 'response'));
  ws.send(audioFrame(requestId, 'AAA'));
  ws.send(textFrame(requestId, 'audio.metadata', '{"Metadata":[]}'));
  ws.send(audioFrame(requestId, 'BBB'));
  ws.send(audioFrame('someoneelse0000000000000000000000', 'XXX'));
  ws.send(audioFrame(requestId, 'CCC'));
  ws.send(textFrame(requestId, 'turn.end'));
};

/** Resolves true when `p` settles within `ms`. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
}

function expectNoSecrets(err: unknown, spoken?: string) {
  const msg = (err as Error).message;
  expect(msg).not.toContain('TrustedClientToken');
  expect(msg).not.toContain('Sec-MS-GEC');
  expect(msg).not.toContain('6A5AA1D4EAFF4E9FB37E23D68491D6F4');
  expect(msg).not.toContain('127.0.0.1');
  if (spoken) expect(msg).not.toContain(spoken);
}

describe('Sec-MS-GEC token', () => {
  test('is SHA-256 of the 5-minute Windows tick window and the client token, uppercase hex', () => {
    // 1791888000 s is 2026-10-13T10:40:00Z, a window start: Windows ticks
    // (1791888000 + 11644473600) * 1e7 = 134363616000000000. Expected digest
    // computed outside this code with:
    //   printf '%s' 1343636160000000006A5AA1D4EAFF4E9FB37E23D68491D6F4 | sha256sum
    const token = secMsGec(1791888000_000);
    expect(token).toMatch(/^[0-9A-F]{64}$/);
    expect(token).toBe(EXPECTED_GEC);
    // Same window up to 299.999 s later, a new one at 300 s.
    expect(secMsGec(1791888299_999)).toBe(EXPECTED_GEC);
    expect(secMsGec(1791888300_000)).not.toBe(EXPECTED_GEC);
  });
});

describe('voice, prosody and text', () => {
  test('expands short voice names the way the service expects', () => {
    expect(edgeVoiceName('en-US-AriaNeural')).toBe('Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)');
    expect(edgeVoiceName('fr-FR-VivienneMultilingualNeural'))
      .toBe('Microsoft Server Speech Text to Speech Voice (fr-FR, VivienneMultilingualNeural)');
    expect(edgeVoiceName('zh-CN-liaoning-XiaobeiNeural'))
      .toBe('Microsoft Server Speech Text to Speech Voice (zh-CN-liaoning, XiaobeiNeural)');
    expect(edgeVoiceName('iu-Latn-CA-TaqqiqNeural'))
      .toBe('Microsoft Server Speech Text to Speech Voice (iu-Latn-CA, TaqqiqNeural)');
    const long = 'Microsoft Server Speech Text to Speech Voice (it-IT, ElsaNeural)';
    expect(edgeVoiceName(long)).toBe(long);
  });

  test('refuses voices and prosody that are not plain values, without echoing them', async () => {
    for (const voice of [
      'alloy', 'en-US-Aria', "en-US-Aria'Neural", "x' onload='1",
      "Microsoft Server Speech Text to Speech Voice (en-US, Aria'Neural)",
      "Microsoft Server Speech Text to Speech Voice (a,b)'><x>",
    ]) {
      expect(() => edgeVoiceName(voice)).toThrow('Invalid Edge TTS voice');
    }
    for (const bad of [{ rate: 'fast' }, { rate: '+10.5%' }, { volume: "+0%' x='" }, { pitch: 'high' }, { pitch: '+3%' }]) {
      const err = await edgeSynthesize('hi', { ...PROSODY, timeoutMs: 1000, ...bad }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/^Invalid Edge TTS (rate|volume|pitch)/);
      expect((err as Error).message).not.toContain(Object.values(bad)[0]!);
    }
  });

  test('escapes markup and drops control characters XML forbids', () => {
    expect(escapeSsmlText(`a<b>&'"c`)).toBe('a&lt;b&gt;&amp;&apos;&quot;c');
    expect(escapeSsmlText('a\u0001b\u000bc\td\ne')).toBe('a b c\td\ne');
    expect(escapeSsmlText('a\uFFFEb\uFFFFc')).toBe('a b c');
    const ssml = buildSsml(escapeSsmlText('</prosody><x>'), PROSODY);
    expect(ssml).toBe(
      "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
      "<voice name='Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)'>" +
      "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>&lt;/prosody&gt;&lt;x&gt;</prosody></voice></speak>",
    );
  });

  test('splits long text on whitespace within the byte bound, never inside an entity or a character', () => {
    const words = Array.from({ length: 400 }, (_, i) => `w${i}é&😀`).join(' ');
    const pieces = splitEscapedText(words, 200);
    expect(pieces.length).toBeGreaterThan(10);
    for (const p of pieces) {
      expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(200);
      expect(p).not.toMatch(/&[a-z]*$/); // no cut entity at the end
      expect(p).not.toMatch(/^[a-z]*;/); // or at the start
      expect(p.isWellFormed()).toBe(true);
    }
    expect(pieces.join(' ')).toBe(escapeSsmlText(words));
    // A run with no whitespace is still cut within the bound.
    const run = splitEscapedText('&'.repeat(100), 22);
    for (const p of run) expect(p).toMatch(/^(&amp;)+$/);
    expect(run.join('')).toBe('&amp;'.repeat(100));
    expect(splitEscapedText('   \n ')).toEqual([]);
    // A space just past the limit is the cut, not the space before it.
    expect(splitEscapedText('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
  });

  test('splitting holds its invariants on random text', () => {
    let seed = 1166;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const alphabet = ['a', 'b', ' ', '\n', '&', '<', '"', "'", 'é', '😀', '中', '\u0001', '\uD800'];
    for (let round = 0; round < 500; round++) {
      const text = Array.from({ length: rand(300) }, () => alphabet[rand(alphabet.length)]).join('');
      const max = 6 + rand(40);
      const pieces = splitEscapedText(text, max);
      for (const p of pieces) {
        expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(max);
        expect(p.isWellFormed()).toBe(true);
        expect(p).toBe(p.trim());
        expect(p.length).toBeGreaterThan(0);
        // Every '&' in a piece starts a whole entity inside it.
        expect(p.replace(/&(amp|lt|gt|quot|apos);/g, '')).not.toContain('&');
      }
      expect(pieces.join('').replace(/\s/g, '')).toBe(escapeSsmlText(text).replace(/\s/g, ''));
    }
  });

  test('splitting is linear: 4M characters that each escape to an entity split in well under 2s', () => {
    // Measured: the first version re-encoded the rest per piece and took
    // 7.7s here; this one takes about 0.13s.
    const started = performance.now();
    const pieces = splitEscapedText('&'.repeat(4_000_000));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(pieces).toHaveLength(Math.ceil((4_000_000 * 5) / (Math.floor(4096 / 5) * 5)));
  });

  test('parses binary frames and refuses a header longer than the frame', () => {
    const parsed = parseBinaryMessage(audioFrame('r1', 'xyz'))!;
    expect(parsed.headers.get('path')).toBe('audio');
    expect(parsed.headers.get('x-requestid')).toBe('r1');
    expect(new TextDecoder().decode(parsed.audio)).toBe('xyz');
    expect(parseBinaryMessage(new Uint8Array([0xff, 0xff, 1, 2]))).toBeNull();
    expect(parseBinaryMessage(new Uint8Array([0]))).toBeNull();
  });
});

describe('edgeSynthesize against a local fake service', () => {
  test('sends the handshake, config and SSML messages the service expects', async () => {
    const svc = fakeService(speaks);
    await edgeSynthesize(`Hello <you> & 'them'.`, svc.opts({ voice: 'en-GB-SoniaNeural', rate: '+10%', volume: '-5%' }));
    expect(svc.seen).toHaveLength(1);
    const { url, headers, messages } = svc.seen[0]!;
    expect(url.pathname).toBe('/edge/v1');
    expect(url.searchParams.get('TrustedClientToken')).toBe('6A5AA1D4EAFF4E9FB37E23D68491D6F4');
    expect(url.searchParams.get('Sec-MS-GEC')).toMatch(/^[0-9A-F]{64}$/);
    expect(url.searchParams.get('Sec-MS-GEC-Version')).toBe('1-143.0.3650.75');
    expect(url.searchParams.get('ConnectionId')).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get('origin')).toBe('chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
    expect(headers.get('user-agent')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    );

    expect(messages).toHaveLength(2);
    const [config, ssml] = messages as [string, string];
    expect(config).toMatch(/^X-Timestamp:[^\r]+ GMT\+0000 \(Coordinated Universal Time\)\r\n/);
    expect(config).toContain('\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n');
    expect(config).toEndWith('}\r\n');
    const body = JSON.parse(config.slice(config.indexOf('\r\n\r\n') + 4));
    expect(body).toEqual({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
          },
        },
      },
    });

    expect(ssml).toMatch(/^X-RequestId:[0-9a-f]{32}\r\nContent-Type:application\/ssml\+xml\r\nX-Timestamp:[^\r]+ GMT\+0000 \(Coordinated Universal Time\)Z\r\nPath:ssml\r\n\r\n/);
    expect(ssml).toContain("<voice name='Microsoft Server Speech Text to Speech Voice (en-GB, SoniaNeural)'>");
    expect(ssml).toContain("<prosody pitch='+0Hz' rate='+10%' volume='-5%'>Hello &lt;you&gt; &amp; &apos;them&apos;.</prosody>");
  });

  test('assembles the audio of its own turn in order and closes the socket', async () => {
    const svc = fakeService(speaks);
    const audio = await edgeSynthesize('hi', svc.opts());
    expect(audio.toString()).toBe('AAABBBCCC');
    expect(await settlesWithin(svc.seen[0]!.closed, 2000)).toBe(true);
  });

  test('speaks long text as several turns and concatenates them', async () => {
    let n = 0;
    const svc = fakeService(({ ws, requestId, ssml }) => {
      const words = /'>([^<]*)<\/prosody>/.exec(ssml)![1]!.split(' ').length;
      ws.send(audioFrame(requestId, `[${n++}:${words}]`));
      ws.send(textFrame(requestId, 'turn.end'));
    });
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const audio = await edgeSynthesize(text, svc.opts({ maxSsmlTextBytes: 60 }));
    expect(svc.seen.length).toBeGreaterThan(1);
    expect(audio.toString()).toMatch(/^(\[\d+:\d+\])+$/);
    const turns = [...audio.toString().matchAll(/\[(\d+):(\d+)\]/g)];
    expect(turns.map((m) => Number(m[1]))).toEqual(turns.map((_, i) => i));
    expect(turns.reduce((s, m) => s + Number(m[2]), 0)).toBe(30);
  });

  test('a timeout rejects and closes the socket of a service that never answers', async () => {
    const svc = fakeService(() => { /* never answers */ });
    const started = Date.now();
    const err = await edgeSynthesize('secret words', svc.opts({ timeoutMs: 150 })).catch((e) => e);
    expect((err as Error).message).toBe('Edge TTS timed out after 150ms');
    expect(Date.now() - started).toBeLessThan(2000);
    expectNoSecrets(err, 'secret words');
    // The service sees the connection go, it is not left open.
    expect(await settlesWithin(svc.seen[0]!.closed, 2000)).toBe(true);
  });

  test('an abort rejects with its reason and closes the socket', async () => {
    let answered!: () => void;
    const turnStarted = new Promise<void>((r) => { answered = r; });
    const svc = fakeService(({ ws, requestId }) => { ws.send(audioFrame(requestId, 'partial')); answered(); });
    const ac = new AbortController();
    const p = edgeSynthesize('hi', svc.opts({ signal: ac.signal, timeoutMs: 10_000 }));
    await turnStarted;
    ac.abort(new Error('caller went away'));
    await expect(p).rejects.toThrow('caller went away');
    expect(await settlesWithin(svc.seen[0]!.closed, 2000)).toBe(true);
  });

  test('an already aborted signal opens nothing', async () => {
    const svc = fakeService(speaks);
    const ac = new AbortController();
    ac.abort(new Error('early'));
    await expect(edgeSynthesize('hi', svc.opts({ signal: ac.signal }))).rejects.toThrow('early');
    expect(svc.seen).toHaveLength(0);
  });

  test('a service that closes mid-turn is an error naming only the close code', async () => {
    const svc = fakeService(({ ws, requestId }) => { ws.send(audioFrame(requestId, 'A')); ws.close(1011, 'internal 6A5AA1D4'); });
    const err = await edgeSynthesize('secret words', svc.opts()).catch((e) => e);
    expect((err as Error).message).toBe('Edge TTS connection closed before the audio finished (code 1011)');
    expectNoSecrets(err, 'secret words');
  });

  test('a refused handshake fails fast as "unavailable in this region", without the URL or its token', async () => {
    const svc = fakeService(speaks, 403);
    const started = Date.now();
    const err = await edgeSynthesize('secret words', svc.opts({ timeoutMs: 30_000 })).catch((e) => e);
    // Not the 30s timeout the old package ran into on every sentence.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err).toBeInstanceOf(EdgeTTSError);
    expect((err as EdgeTTSError).code).toBe('unavailable');
    expect((err as Error).message).toBe(EDGE_UNAVAILABLE_MESSAGE);
    expectNoSecrets(err, 'secret words');
    // Settings can tell, until a synthesis works again.
    expect(edgeTtsStatus().unavailable).toBe(true);
    server!.stop(true);
    const ok = fakeService(speaks);
    await edgeSynthesize('hi', ok.opts());
    expect(edgeTtsStatus()).toEqual({ unavailable: false, since: null });
  });

  test('a service that cannot be reached at all is "unreachable", not "unavailable"', async () => {
    // Accepts TCP and hangs up at once: neither the handshake nor the probe gets an answer.
    const tcp = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { open(s) { s.end(); }, data() {} } });
    try {
      const err = await edgeSynthesize('hi', { ...PROSODY, timeoutMs: 10_000, endpoint: `ws://127.0.0.1:${tcp.port}/v1` })
        .catch((e) => e);
      expect((err as EdgeTTSError).code).toBe('unreachable');
      expect((err as Error).message).toBe(EDGE_UNREACHABLE_MESSAGE);
      expect(edgeTtsStatus().unavailable).toBe(false);
    } finally {
      tcp.stop(true);
    }
  });

  test('a turn with no audio, or a malformed audio frame, is an error', async () => {
    let svc = fakeService(({ ws, requestId }) => ws.send(textFrame(requestId, 'turn.end')));
    await expect(edgeSynthesize('hi', svc.opts())).rejects.toThrow('Edge TTS returned no audio');
    server!.stop(true);
    svc = fakeService(({ ws }) => ws.send(new Uint8Array([0x10, 0x00, 1])));
    await expect(edgeSynthesize('hi', svc.opts())).rejects.toThrow('malformed audio message');
    expect(await settlesWithin(svc.seen[0]!.closed, 2000)).toBe(true);
  });

  test('stops buffering and closes the socket past the size limit', async () => {
    const svc = fakeService(({ ws, requestId }) => {
      for (let i = 0; i < 20; i++) ws.send(audioFrame(requestId, new Uint8Array(1000)));
      ws.send(textFrame(requestId, 'turn.end'));
    });
    const err = await edgeSynthesize('hi', svc.opts({ maxAudioBytes: 5000 })).catch((e) => e);
    // The audio check itself stops it, at the sixth frame, not the turn.end after.
    expect((err as Error).message).toBe('Edge TTS audio exceeded the size limit');
    expect(await settlesWithin(svc.seen[0]!.closed, 2000)).toBe(true);
    // Under the limit the same answer succeeds, so the bound is what failed it.
    const ok = await edgeSynthesize('hi', svc.opts({ maxAudioBytes: 30_000 }));
    expect(ok.length).toBe(20_000);
  });

  test('text messages count against the size limit too', async () => {
    const svc = fakeService(({ ws, requestId }) => {
      ws.send(audioFrame(requestId, 'A'));
      for (let i = 0; i < 50; i++) ws.send(textFrame(requestId, 'audio.metadata', 'x'.repeat(500)));
      ws.send(textFrame(requestId, 'turn.end'));
    });
    await expect(edgeSynthesize('hi', svc.opts({ maxAudioBytes: 5000 })))
      .rejects.toThrow('Edge TTS sent more data than the size limit allows');
    // Small ones are charged the per-message overhead: 100 of about 80 bytes are 8 KB of data, 34 KB charged.
    server!.stop(true);
    const small = fakeService(({ ws, requestId }) => {
      ws.send(audioFrame(requestId, 'A'));
      for (let i = 0; i < 100; i++) ws.send(textFrame(requestId, 'audio.metadata', ''));
      ws.send(textFrame(requestId, 'turn.end'));
    });
    await expect(edgeSynthesize('hi', small.opts({ maxAudioBytes: 20_000 })))
      .rejects.toThrow('Edge TTS sent more data than the size limit allows');
  });

  test('whitespace-only text is no audio, with no connection', async () => {
    const svc = fakeService(speaks);
    expect((await edgeSynthesize(' \n ', svc.opts())).length).toBe(0);
    expect(svc.seen).toHaveLength(0);
  });
});

const EXPECTED_GEC = 'BAEFD8F174F09976888D18FCA9232CD4B7A7C815A7761A735832538CC5E90870';

describe('edgeSynthesize lifecycle and clock', () => {
  test('a timeout while the handshake hangs closes the connection', async () => {
    let closed!: () => void;
    const gone = new Promise<void>((r) => { closed = r; });
    const tcp = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: { data() { /* never answers the upgrade */ }, close() { closed(); } },
    });
    try {
      const err = await edgeSynthesize('hi', { ...PROSODY, timeoutMs: 150, endpoint: `ws://127.0.0.1:${tcp.port}/v1` })
        .catch((e) => e);
      expect((err as Error).message).toBe('Edge TTS timed out after 150ms');
      expect(await settlesWithin(gone, 2000)).toBe(true);
    } finally {
      tcp.stop(true);
    }
  });

  test('the deadline covers every chunk: a later turn that hangs times out and its socket closes', async () => {
    let turn = 0;
    const svc = fakeService(({ ws, requestId }) => {
      if (turn++ > 0) return; // the second turn never answers
      ws.send(audioFrame(requestId, 'A'));
      ws.send(textFrame(requestId, 'turn.end'));
    });
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const err = await edgeSynthesize(text, svc.opts({ maxSsmlTextBytes: 60, timeoutMs: 2000 })).catch((e) => e);
    expect((err as Error).message).toBe('Edge TTS timed out after 2000ms');
    expect(svc.seen).toHaveLength(2);
    expect(await settlesWithin(Promise.all(svc.seen.map((s) => s.closed)), 2000)).toBe(true);
  });

  test('removes every abort listener it adds, per chunk and overall, on success and on failure', async () => {
    // Counts abort listeners on every signal, the internal per-synthesis one included.
    const proto = AbortSignal.prototype as unknown as EventTarget;
    const add = proto.addEventListener;
    const remove = proto.removeEventListener;
    let live = 0;
    let added = 0;
    proto.addEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (type === 'abort') { live++; added++; }
      return (add as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof add;
    proto.removeEventListener = function (this: EventTarget, type: string, ...rest: unknown[]) {
      if (type === 'abort') live--;
      return (remove as (...a: unknown[]) => void).call(this, type, ...rest);
    } as typeof remove;
    try {
      const svc = fakeService(speaks);
      const ac = new AbortController();
      await edgeSynthesize('one two three', svc.opts({ signal: ac.signal, maxSsmlTextBytes: 5 }));
      expect(svc.seen.length).toBe(3);
      expect(added).toBe(4); // the caller's signal once, then one per chunk
      expect(live).toBe(0);
      server!.stop(true);
      const silent = fakeService(() => {});
      await expect(edgeSynthesize('hi', silent.opts({ signal: ac.signal, timeoutMs: 100 }))).rejects.toThrow('timed out');
      expect(live).toBe(0);
    } finally {
      proto.addEventListener = add;
      proto.removeEventListener = remove;
    }
  });

  test('each message is charged a fixed overhead, so many tiny ones cannot outgrow the bound', async () => {
    const tiny = (n: number): Behaviour => ({ ws, requestId }) => {
      for (let i = 0; i < n; i++) ws.send(audioFrame(requestId, 'x'));
      ws.send(textFrame(requestId, 'turn.end'));
    };
    // 1000 frames of about 75 bytes are 75 KB of data but 331 KB charged.
    let svc = fakeService(tiny(1000));
    await expect(edgeSynthesize('hi', svc.opts({ maxAudioBytes: 200_000 })))
      .rejects.toThrow('Edge TTS audio exceeded the size limit');
    server!.stop(true);
    svc = fakeService(tiny(100));
    expect((await edgeSynthesize('hi', svc.opts({ maxAudioBytes: 200_000 }))).length).toBe(100);
  });

  test('binary messages that are not our audio count against the size limit', async () => {
    const svc = fakeService(({ ws, requestId }) => {
      ws.send(audioFrame(requestId, 'A'));
      for (let i = 0; i < 10; i++) ws.send(audioFrame('someoneelse0000000000000000000000', new Uint8Array(1000)));
      ws.send(textFrame(requestId, 'turn.end'));
    });
    await expect(edgeSynthesize('hi', svc.opts({ maxAudioBytes: 5000 })))
      .rejects.toThrow('Edge TTS audio exceeded the size limit');
  });

  test('a refusal caused by a wrong local clock is retried once with the service clock', async () => {
    const ahead = 3_600_000;
    // The service takes only a token for its own window, an hour ahead of ours.
    const svc = fakeService(
      speaks,
      // The client learns the skew from a Date header with one-second
      // resolution, so it may be just behind; take the window 2s back too.
      (url) => ([secMsGec(Date.now() + ahead), secMsGec(Date.now() + ahead - 2000)]
        .includes(url.searchParams.get('Sec-MS-GEC')!) ? undefined : 403),
      () => new Date(Date.now() + ahead).toUTCString(),
    );
    const audio = await edgeSynthesize('hi', svc.opts());
    expect(audio.toString()).toBe('AAABBBCCC');
    expect(svc.seen).toHaveLength(2);
    // The correction is kept: the next request needs no retry.
    await edgeSynthesize('hi', svc.opts());
    expect(svc.seen).toHaveLength(3);
  });

  test('a connection that cannot even be constructed is an error without the URL', async () => {
    const err = await edgeSynthesize('hi', { ...PROSODY, timeoutMs: 1000, endpoint: 'ws://[not a host' }).catch((e) => e);
    expect((err as Error).message).toBe('Edge TTS could not open a connection');
  });

  test('a learned skew is dropped when the retry fails too', async () => {
    const svc = fakeService(speaks, 403, () => new Date(Date.now() + 3_600_000).toUTCString());
    await expect(edgeSynthesize('hi', svc.opts())).rejects.toThrow(EDGE_UNAVAILABLE_MESSAGE);
    expect(svc.seen).toHaveLength(2);
    // The next request starts from our own clock again.
    await expect(edgeSynthesize('hi', svc.opts())).rejects.toThrow(EDGE_UNAVAILABLE_MESSAGE);
    // (Either side of a window edge that the request may have crossed.)
    expect([secMsGec(Date.now()), secMsGec(Date.now() - 5000)])
      .toContain(svc.seen[2]!.url.searchParams.get('Sec-MS-GEC')!);
  });

  test('a refusal with the clocks in step is not retried', async () => {
    const svc = fakeService(speaks, 403, () => new Date().toUTCString());
    const err = await edgeSynthesize('secret words', svc.opts()).catch((e) => e);
    expect((err as Error).message).toBe(EDGE_UNAVAILABLE_MESSAGE);
    expectNoSecrets(err, 'secret words');
    expect(svc.seen).toHaveLength(1);
  });
});
