/**
 * Minimal client for Microsoft Edge's online "Read Aloud" text-to-speech
 * service (#1166). It replaces the AGPL-3.0 edge-tts-universal package. It is
 * a clean implementation, written from the protocol as observed on the wire
 * and as publicly described; no code from that package or any other
 * implementation was copied or ported.
 *
 * The protocol, per synthesis request:
 *   1. Open a websocket to ENDPOINT. The query carries the public client
 *      token, a Sec-MS-GEC token derived from the clock (secMsGec), the
 *      version it belongs to, and a connection id. The handshake must carry
 *      Edge's extension Origin and an Edge User-Agent.
 *   2. Send a text "speech.config" message choosing the output format.
 *   3. Send a text "ssml" message with the SSML to speak.
 *   4. The service answers with text messages (turn.start, response,
 *      audio.metadata, turn.end) and binary audio messages. A binary message
 *      is a 2-byte big-endian header length, the header text, then the audio
 *      bytes. turn.end closes the turn.
 * Every text message is "Name:value" header lines joined by CRLF, a blank
 * line, then the body.
 *
 * Each chunk of a long text is spoken over its own connection, and the MP3
 * of every chunk is concatenated (MP3 frames concatenate into a valid file).
 */

/** The public client token Edge sends; it is not a secret. */
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
/** The Edge release whose token scheme and User-Agent are sent. */
const EDGE_VERSION = '143.0.3650.75';
const EDGE_MAJOR = EDGE_VERSION.split('.')[0];
export const EDGE_TTS_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`;
/** 24 kHz mono MP3 at 48 kbit/s: what voice.ts has always produced. */
export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/**
 * Most text bytes (after XML escaping) put in one SSML message. Longer text
 * is split on whitespace. Not measured against the service: it refused
 * every handshake (HTTP 403) from the machine this was written on, so the
 * service's real limit is still to be confirmed by a live run.
 */
export const MAX_SSML_TEXT_BYTES = 4096;

/**
 * Most bytes (audio, plus the text messages) taken in for one synthesis.
 * The format is 48 kbit/s, so 6000 bytes per second of speech; this is 30
 * minutes of speech, far beyond any reply, and it stops a misbehaving peer
 * from growing the buffer forever.
 */
export const MAX_AUDIO_BYTES = 6000 * 60 * 30;

/**
 * What each message from the service is charged against MAX_AUDIO_BYTES on
 * top of its size, so many tiny messages cannot cost far more memory than
 * the bytes they carry. Measured: retaining 200,000 15-byte audio chunks
 * cost 252 bytes of RSS each on Bun 1.3.8 and 157 on Bun 1.4.2.
 */
export const MESSAGE_OVERHEAD_BYTES = 256;

/**
 * Most UTF-8 bytes accepted in one text message from the service. Like
 * MAX_AUDIO_BYTES it is checked after Bun has received the whole message:
 * Bun's client WebSocket has no maximum message size, so one huge frame
 * from a hostile endpoint is still held in memory once before it is refused.
 */
export const MAX_TEXT_MESSAGE_BYTES = 64 * 1024;

/**
 * How far the service's clock is ahead of ours, learned from its Date header
 * after a refused handshake, so a machine with a wrong clock still gets a
 * token for the service's current window.
 */
let clockSkewMs = 0;

/** A refusal is retried once with a corrected clock only when the clocks differ by at least this. */
export const CLOCK_SKEW_RETRY_MS = 60_000;

/** Tests only. */
export function resetClockSkew(): void {
  clockSkewMs = 0;
}

/** Seconds between 1601-01-01 (the Windows file time epoch) and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET_S = 11_644_473_600;

/**
 * The Sec-MS-GEC token (version 1): the current time in Windows file time
 * (100 ns ticks since 1601), rounded down to a 5-minute window, written as a
 * decimal integer, followed by the client token, SHA-256 hashed and written
 * as uppercase hex. The service accepts a token for its own window.
 */
export function secMsGec(nowMs: number = Date.now() + clockSkewMs): string {
  const seconds = BigInt(Math.floor(nowMs / 1000) + WINDOWS_EPOCH_OFFSET_S);
  const ticks = (seconds - (seconds % 300n)) * 10_000_000n;
  return new Bun.CryptoHasher('sha256').update(`${ticks}${TRUSTED_CLIENT_TOKEN}`).digest('hex').toUpperCase();
}

/** A locale, with an optional script ("iu-Latn-CA") and regional variant ("zh-CN-liaoning"). */
const LOCALE = '[a-z]{2,3}(?:-[A-Z][a-z]{3})?-[A-Z]{2,3}(?:-[A-Za-z]+)?';
const SHORT_VOICE = new RegExp(`^(${LOCALE})-([A-Za-z0-9]+Neural)$`);
const LONG_VOICE = new RegExp(`^Microsoft Server Speech Text to Speech Voice \\(${LOCALE}, [A-Za-z0-9]+Neural\\)$`);
const PERCENT = /^[+-]\d+%$/;
const HERTZ = /^[+-]\d+Hz$/;

/**
 * The service's full voice name for a short one: "en-US-AriaNeural" becomes
 * "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)", and a
 * regional variant "zh-CN-liaoning-XiaobeiNeural" keeps its region in the
 * locale part. A full name passes through. Anything else is refused, so the
 * name can never carry markup into the SSML.
 */
export function edgeVoiceName(voice: string): string {
  if (LONG_VOICE.test(voice)) return voice;
  const m = SHORT_VOICE.exec(voice);
  if (!m) throw new Error('Invalid Edge TTS voice (expected a name like en-US-AriaNeural)');
  return `Microsoft Server Speech Text to Speech Voice (${m[1]}, ${m[2]})`;
}

/**
 * Text as SSML character data: XML-escaped, with the characters XML 1.0
 * forbids (controls below 0x20 but tab, LF and CR, and U+FFFE/U+FFFF)
 * replaced by spaces, and lone surrogates replaced so the UTF-8 is valid.
 */
export function escapeSsmlText(text: string): string {
  return text
    .toWellFormed()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface EdgeProsody {
  voice: string;
  /** e.g. "+0%", "-10%" */
  rate: string;
  /** e.g. "+0%", "+20%" */
  volume: string;
  /** e.g. "+0Hz" */
  pitch: string;
}

/** Check the prosody values before anything is sent. Throws with no value echoed. */
export function validateProsody(p: EdgeProsody): void {
  edgeVoiceName(p.voice);
  if (!PERCENT.test(p.rate)) throw new Error('Invalid Edge TTS rate (expected e.g. +0% or -10%)');
  if (!PERCENT.test(p.volume)) throw new Error('Invalid Edge TTS volume (expected e.g. +0% or -10%)');
  if (!HERTZ.test(p.pitch)) throw new Error('Invalid Edge TTS pitch (expected e.g. +0Hz)');
}

/** The SSML document for one chunk of already-escaped text. */
export function buildSsml(escapedText: string, p: EdgeProsody): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${edgeVoiceName(p.voice)}'>` +
    `<prosody pitch='${p.pitch}' rate='${p.rate}' volume='${p.volume}'>${escapedText}</prosody>` +
    `</voice></speak>`
  );
}

const WHITESPACE = /\s/;

/**
 * Escape `text` and split it into pieces of at most `maxBytes` UTF-8 bytes,
 * preferring the last whitespace before the limit and never cutting through
 * an XML entity or a code point. Whitespace-only text yields no pieces.
 */
export function splitEscapedText(text: string, maxBytes: number = MAX_SSML_TEXT_BYTES): string[] {
  // One pass with a running byte count: the text comes from model replies,
  // so re-encoding the remainder per piece (quadratic) is not acceptable.
  const s = escapeSsmlText(text);
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && WHITESPACE.test(s[i]!)) i++;
    if (i >= n) break;
    let j = i;
    let bytes = 0;
    let lastSpace = -1; // last whitespace in the piece so far
    let openEntity = -1; // the '&' of an entity not yet closed by ';'
    while (j < n) {
      const cp = s.codePointAt(j)!;
      const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (bytes + size > maxBytes) break;
      const c = s[j]!;
      if (c === '&') openEntity = j;
      else if (c === ';') openEntity = -1;
      else if (WHITESPACE.test(c)) lastSpace = j;
      bytes += size;
      j += cp > 0xffff ? 2 : 1; // a surrogate pair is never split
    }
    let cut = j;
    if (j < n && !WHITESPACE.test(s[j]!)) {
      if (lastSpace > i) cut = lastSpace;
      else if (openEntity !== -1) cut = openEntity; // never split an entity
    }
    // maxBytes below one entity or character: nothing fits.
    if (cut <= i) throw new Error('Edge TTS text could not be split');
    out.push(s.slice(i, cut).trimEnd());
    i = cut;
  }
  return out;
}

/** e.g. "Thu, 05 Nov 2026 19:16:54 GMT+0000 (Coordinated Universal Time)" */
function timestamp(): string {
  return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');
}

function newId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export function configMessage(): string {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
          outputFormat: EDGE_OUTPUT_FORMAT,
        },
      },
    },
  });
  return `X-Timestamp:${timestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${body}\r\n`;
}

export function ssmlMessage(requestId: string, ssml: string): string {
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

/** Header lines of a message, names lowercased. */
function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

/** A text message's headers and body. */
export function parseTextMessage(message: string): { headers: Map<string, string>; body: string } {
  const split = message.indexOf('\r\n\r\n');
  if (split === -1) return { headers: parseHeaders(message), body: '' };
  return { headers: parseHeaders(message.slice(0, split)), body: message.slice(split + 4) };
}

/** A binary message's headers and audio payload, or null when it is malformed. */
export function parseBinaryMessage(data: Uint8Array): { headers: Map<string, string>; audio: Uint8Array } | null {
  if (data.length < 2) return null;
  const headerLength = (data[0]! << 8) | data[1]!;
  if (2 + headerLength > data.length) return null;
  const headers = parseHeaders(new TextDecoder().decode(data.subarray(2, 2 + headerLength)));
  return { headers, audio: data.subarray(2 + headerLength) };
}

export interface EdgeSynthesisOptions extends EdgeProsody {
  /** Overall deadline for the whole text, all chunks included. */
  timeoutMs: number;
  /** Aborts the synthesis and closes the socket. */
  signal?: AbortSignal;
  /** Tests only: a ws:// endpoint to use instead of the service. */
  endpoint?: string;
  /** Tests only. */
  maxAudioBytes?: number;
  /** Tests only. */
  maxSsmlTextBytes?: number;
}

/**
 * Why a synthesis failed, for callers that report it: "unavailable" when the
 * service answers but refuses this client (Microsoft has moved some regions to
 * a token this client does not implement, #1166), "unreachable" when it
 * cannot be reached at all.
 */
export type EdgeTTSErrorCode = 'unavailable' | 'unreachable' | 'failed';

/** What a user sees when the service refuses this client. */
export const EDGE_UNAVAILABLE_MESSAGE =
  'Edge TTS is unavailable in this region: Microsoft\'s service refused the connection. ' +
  'Choose another voice provider in Settings.';
export const EDGE_UNREACHABLE_MESSAGE = 'Edge TTS could not reach Microsoft\'s service. Check the network connection.';

/** A failed synthesis. The message never carries the URL, its token or the spoken text. */
export class EdgeTTSError extends Error {
  /** The handshake itself was refused (wrong token, clock, region, or a blocked network). */
  readonly refused: boolean;
  readonly code: EdgeTTSErrorCode;
  constructor(message: string, refused = false, code: EdgeTTSErrorCode = 'failed') {
    super(message);
    this.name = 'EdgeTTSError';
    this.refused = refused;
    this.code = code;
  }
}

/** When the service last refused this client as unavailable; cleared by any synthesis that works. */
let unavailableSince: number | null = null;

/** Whether Edge TTS was last found unavailable here, for Settings to say so. */
export function edgeTtsStatus(): { unavailable: boolean; since: number | null } {
  return { unavailable: unavailableSince !== null, since: unavailableSince };
}

/** Tests only. */
export function resetEdgeTtsStatus(): void {
  unavailableSince = null;
}

function unavailable(): EdgeTTSError {
  unavailableSince ??= Date.now();
  return new EdgeTTSError(EDGE_UNAVAILABLE_MESSAGE, true, 'unavailable');
}

/**
 * Whether the service answers at all, and how far its clock is from ours,
 * from a HEAD request to the endpoint's https (or, for tests, http) form.
 * Any HTTP answer means it is reachable; the skew is null when its Date
 * header is missing. Bounded by `signal`.
 */
async function probeService(endpoint: string, signal: AbortSignal): Promise<{ reachable: boolean; skew: number | null }> {
  try {
    const url = endpoint.replace(/^ws(s?):/, 'http$1:');
    const sent = Date.now();
    const res = await fetch(url, { method: 'HEAD', signal, redirect: 'manual' });
    await res.body?.cancel();
    const date = Date.parse(res.headers.get('date') ?? '');
    // The header has one-second resolution; take our clock halfway through the request.
    return { reachable: true, skew: Number.isNaN(date) ? null : date - (sent + Date.now()) / 2 };
  } catch {
    return { reachable: false, skew: null };
  }
}

/**
 * Synthesize `text` and return the complete MP3. Rejects on timeout, abort,
 * a refused handshake (fast, as "unavailable" or "unreachable"), a
 * connection that closes before the turn ends, a malformed message, too much
 * data, or a turn that ends with no audio. Every socket it opens is closed
 * before it settles.
 */
export async function edgeSynthesize(text: string, opts: EdgeSynthesisOptions): Promise<Buffer> {
  validateProsody(opts);
  const pieces = splitEscapedText(text, opts.maxSsmlTextBytes ?? MAX_SSML_TEXT_BYTES);
  // Nothing to speak is no audio, not an error, and opens no connection (as before).
  if (pieces.length === 0) return Buffer.alloc(0);
  opts.signal?.throwIfAborted();

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new EdgeTTSError(`Edge TTS timed out after ${opts.timeoutMs}ms`)),
    opts.timeoutMs,
  );
  const onAbort = () => controller.abort(opts.signal!.reason ?? new EdgeTTSError('Edge TTS was aborted'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const budget = { left: opts.maxAudioBytes ?? MAX_AUDIO_BYTES };
  try {
    const audio: Uint8Array[] = [];
    let probed = false;
    for (const piece of pieces) {
      try {
        for (const chunk of await synthesizeOne(piece, opts, controller.signal, budget)) audio.push(chunk);
      } catch (err) {
        if (!(err instanceof EdgeTTSError) || !err.refused) throw err;
        if (probed) throw unavailable();
        probed = true;
        // Tell a refusal by the service from no network, and learn its clock:
        // a wrong local clock gets a refused token too.
        const probe = await probeService(opts.endpoint ?? EDGE_TTS_ENDPOINT, controller.signal);
        controller.signal.throwIfAborted();
        if (!probe.reachable) throw new EdgeTTSError(EDGE_UNREACHABLE_MESSAGE, true, 'unreachable');
        const skew = probe.skew;
        if (skew === null || Math.abs(skew - clockSkewMs) < CLOCK_SKEW_RETRY_MS) throw unavailable();
        const previous = clockSkewMs;
        clockSkewMs = skew;
        try {
          for (const chunk of await synthesizeOne(piece, opts, controller.signal, budget)) audio.push(chunk);
        } catch (retryErr) {
          // Keep a learned skew only once it has worked.
          if (clockSkewMs === skew) clockSkewMs = previous; // unless another request has moved it since
          throw retryErr instanceof EdgeTTSError && retryErr.refused ? unavailable() : retryErr;
        }
      }
    }
    unavailableSince = null;
    return Buffer.concat(audio);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** One connection, one turn. */
function synthesizeOne(
  escapedText: string,
  opts: EdgeSynthesisOptions,
  signal: AbortSignal,
  budget: { left: number },
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const connectionId = newId();
    const requestId = newId();
    const query =
      `TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}` +
      `&Sec-MS-GEC-Version=1-${EDGE_VERSION}&ConnectionId=${connectionId}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${opts.endpoint ?? EDGE_TTS_ENDPOINT}?${query}`, {
        headers: {
          Origin: ORIGIN,
          'User-Agent': USER_AGENT,
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        // Bun's options form; the bun-types in use only declare the protocols one.
      } as unknown as string[]);
    } catch {
      // Bun's message would carry the URL and its token.
      reject(new EdgeTTSError('Edge TTS could not open a connection'));
      return;
    }
    ws.binaryType = 'arraybuffer';
    const chunks: Uint8Array[] = [];
    let opened = false;
    let settled = false;

    const finish = (err: unknown, value?: Uint8Array[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        // terminate() drops the connection at once; close() would wait on a
        // peer that may never answer the close frame.
        const t = (ws as unknown as { terminate?: () => void }).terminate;
        if (typeof t === 'function') t.call(ws); else ws.close();
      }
      if (err) reject(err); else resolve(value!);
    };
    const onAbort = () => finish(signal.reason ?? new EdgeTTSError('Edge TTS was aborted'));
    signal.addEventListener('abort', onAbort, { once: true });

    ws.onopen = () => {
      if (settled) return;
      opened = true;
      try {
        ws.send(configMessage());
        ws.send(ssmlMessage(requestId, buildSsml(escapedText, opts)));
      } catch {
        finish(new EdgeTTSError('Edge TTS could not send the request'));
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (settled) return;
      if (typeof event.data === 'string') {
        // Text messages (word timings, one per word) count against the
        // same budget as audio, so their number is bounded too.
        const size = Buffer.byteLength(event.data);
        budget.left -= size + MESSAGE_OVERHEAD_BYTES;
        if (size > MAX_TEXT_MESSAGE_BYTES || budget.left < 0) {
          finish(new EdgeTTSError('Edge TTS sent more data than the size limit allows'));
          return;
        }
        const { headers } = parseTextMessage(event.data);
        if (headers.get('path') === 'turn.end') {
          if (chunks.length === 0) finish(new EdgeTTSError('Edge TTS returned no audio'));
          else finish(null, chunks);
        }
        return;
      }
      const data = new Uint8Array(event.data as ArrayBuffer);
      // Every binary message counts, audio or not, ours or not.
      budget.left -= data.length + MESSAGE_OVERHEAD_BYTES;
      if (budget.left < 0) {
        finish(new EdgeTTSError('Edge TTS audio exceeded the size limit'));
        return;
      }
      const parsed = parseBinaryMessage(data);
      if (!parsed) {
        finish(new EdgeTTSError('Edge TTS sent a malformed audio message'));
        return;
      }
      if (parsed.headers.get('path') !== 'audio') return;
      const rid = parsed.headers.get('x-requestid');
      if (rid !== undefined && rid !== requestId) return; // another turn's audio
      if (parsed.audio.length === 0) return;
      chunks.push(parsed.audio.slice());
    };
    // The error event's message can carry the full URL, token included, so
    // it is never forwarded. Bun reports a refused handshake as a close (it
    // may fire error first), so both report the same way.
    // Refined by edgeSynthesize into "unavailable" or "unreachable".
    const refused = () => new EdgeTTSError('Edge TTS could not connect', true);
    ws.onerror = () => {
      finish(opened ? new EdgeTTSError('Edge TTS connection failed') : refused());
    };
    ws.onclose = (event: CloseEvent) => {
      finish(opened
        ? new EdgeTTSError(`Edge TTS connection closed before the audio finished (code ${event.code})`)
        : refused());
    };
  });
}
