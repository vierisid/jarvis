import type { STTConfig, TTSConfig } from '../config/types.ts';
import { redactSecrets } from '../util/redact.ts';
import { hostedProxyError } from '../util/hosted-error.ts';

export interface STTProvider {
  transcribe(audio: Buffer): Promise<string>;
}

export interface TTSProvider {
  synthesize(text: string): Promise<Buffer>;
  synthesizeStream(text: string): AsyncIterable<Buffer>;
}

/**
 * Hosted "Usejarvis AI" credentials for the voice factories. Sourced from the
 * SYSTEM-owned `usejarvis_ai` config.yaml block at the call sites (see
 * daemon/usejarvis-ai.ts) and passed as a separate argument on purpose:
 * cfg.stt / cfg.tts persist as plaintext JSON in the DB settings store and
 * round-trip through the /api/config routes, so the per-user proxy key must
 * never live inside them.
 */
export type HostedVoiceCredentials = { baseUrl: string; apiKey: string };

/**
 * Sniff the audio container from magic bytes so multipart uploads declare
 * what the buffer actually IS. The same STT provider instance receives
 * dashboard-mic WAV (ui useVoice encodeWav writes a RIFF header), Telegram
 * voice notes (OGG/Opus), and arbitrary Discord attachments — any hardcoded
 * label is wrong for at least one of them, and strict servers (including the
 * hosted proxy) may trust the declared container. Falls back to WAV, the
 * dashboard-mic format, when nothing matches.
 */
export function sniffAudioFormat(audio: Buffer): { filename: string; mimeType: string } {
  if (audio.length >= 4) {
    const magic = audio.toString('latin1', 0, 4);
    if (magic === 'RIFF') return { filename: 'audio.wav', mimeType: 'audio/wav' };
    if (magic === 'OggS') return { filename: 'audio.ogg', mimeType: 'audio/ogg' };
    // EBML header: WebM/Matroska (MediaRecorder output on some browsers).
    if (audio[0] === 0x1a && audio[1] === 0x45 && audio[2] === 0xdf && audio[3] === 0xa3) {
      return { filename: 'audio.webm', mimeType: 'audio/webm' };
    }
    // ID3v2 tag or a bare MPEG frame sync (0xFFEx).
    if (magic.startsWith('ID3') || (audio[0] === 0xff && (audio[1]! & 0xe0) === 0xe0)) {
      return { filename: 'audio.mp3', mimeType: 'audio/mpeg' };
    }
  }
  return { filename: 'audio.wav', mimeType: 'audio/wav' };
}

/**
 * OpenAI Whisper STT — uses the OpenAI /v1/audio/transcriptions endpoint.
 */
export class OpenAIWhisperSTT implements STTProvider {
  private apiKey: string;
  private model: string;
  private language?: string;

  constructor(apiKey: string, model: string = 'whisper-1', language?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    // Label the part from the buffer's magic bytes (dashboard mic sends WAV,
    // Telegram voice notes are OGG/Opus); 'audio.webm' was a mislabel.
    const { filename, mimeType } = sniffAudioFormat(audio);
    formData.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    formData.append('model', this.model);
    // Unset language = let Whisper auto-detect; forcing 'en' made non-English
    // speech decode (or translate) as English on a hosted product.
    if (this.language) formData.append('language', this.language);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI STT error (${response.status}): ${err}`);
    }

    const result = await response.json() as any;
    return result.text;
  }
}

/**
 * Groq Whisper STT — uses Groq's OpenAI-compatible transcriptions endpoint.
 */
export class GroqWhisperSTT implements STTProvider {
  private apiKey: string;
  private model: string;
  private language?: string;

  constructor(apiKey: string, model: string = 'whisper-large-v3-turbo', language?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    // Same magic-byte labeling as OpenAIWhisperSTT.
    const { filename, mimeType } = sniffAudioFormat(audio);
    formData.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    formData.append('model', this.model);
    if (this.language) formData.append('language', this.language);

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq STT error (${response.status}): ${err}`);
    }

    const result = await response.json() as any;
    return result.text;
  }
}

/**
 * Hosted "Usejarvis AI" STT — the platform proxy's OpenAI-compatible
 * /audio/transcriptions endpoint. `uj-stt` is a stable per-plan alias the
 * proxy resolves server-side (same scheme as the uj-* LLM tiers). Credentials
 * come from the system-owned `usejarvis_ai` block via the factory's `hosted`
 * argument — never from cfg.stt.
 */
export class UsejarvisSTT implements STTProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private language?: string;

  /** Bound on how long one hosted transcription round-trip may take. */
  static readonly TIMEOUT_MS = 30_000;
  /** Bound on how much of an ERROR body is read into memory (the caps below
   * truncate to 200 chars AFTER the read — an unbounded read of a
   * multi-megabyte interstitial would buffer it whole first, per request,
   * on a memory-capped multi-tenant host). */
  static readonly MAX_ERROR_BODY_BYTES = 8_192;
  /** Bound on a SUCCESS body: generous (a transcript of hours of speech fits
   * easily), but still a ceiling a misbehaving CDN cannot exceed. */
  static readonly MAX_BODY_BYTES = 1_048_576;

  constructor(baseUrl: string, apiKey: string, model: string = 'uj-stt', language?: string) {
    // The provisioner writes the proxy ORIGIN; normalize to the /v1 prefix
    // exactly like UsejarvisAIProvider (src/llm/usejarvis.ts) does.
    const trimmed = baseUrl.replace(/\/+$/, '');
    this.baseUrl = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
  }

  /** Read at most maxBytes from the response body. */
  private static async boundedText(response: Response, maxBytes: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    // Magic-byte labeling matters most here: the hosted proxy may trust the
    // declared container, and this instance sees dashboard WAV and Telegram
    // OGG/Opus alike.
    const { filename, mimeType } = sniffAudioFormat(audio);
    formData.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
    formData.append('model', this.model);
    if (this.language) formData.append('language', this.language);

    // Timeout: a hung proxy/CDN left Telegram and WS transcribe calls pending
    // forever with no user-visible failure.
    const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(UsejarvisSTT.TIMEOUT_MS),
    });

    if (!response.ok) {
      const err = await UsejarvisSTT.boundedText(response, UsejarvisSTT.MAX_ERROR_BODY_BYTES);
      // Shared mapper: budgets block audio endpoints too, so a hosted user
      // WILL hit this — they should get "your included usage is used up …",
      // not the raw proxy JSON (or, behind a CDN, a whole HTML page carrying
      // the hosted hostname) in a browser toast.
      throw hostedProxyError('Usejarvis AI STT', response.status, err);
    }

    // Read as TEXT first: response.json() rejects before the shape check
    // below, and its rejection ("Failed to parse JSON") carries no provider,
    // no status and none of the body — so an HTML interstitial served with a
    // 200 produced a bare parse error with nothing to correlate. Reading the
    // body ourselves keeps the diagnostic, still redacted and still capped.
    // Bounded: a real transcript fits well under the cap; an interstitial
    // does not deserve more memory than the cap.
    const raw = await UsejarvisSTT.boundedText(response, UsejarvisSTT.MAX_BODY_BYTES);
    let result: { text?: string };
    try {
      result = JSON.parse(raw) as { text?: string };
    } catch {
      throw new Error(
        `Usejarvis AI STT returned a non-JSON body: ${redactSecrets(raw).slice(0, 200)}`,
      );
    }
    if (typeof result.text !== 'string') {
      // Same class as the error branch: a 200 carrying a proxy/CDN
      // interstitial is exactly where an echoed bearer shows up.
      throw new Error(
        `Usejarvis AI STT returned no transcript: ${redactSecrets(JSON.stringify(result)).slice(0, 200)}`,
      );
    }
    return result.text;
  }
}

/**
 * Local Whisper STT — connects to a whisper.cpp HTTP server or OpenAI-compatible endpoint.
 */
export type LocalWhisperServerType = 'whisper_cpp' | 'openai_compatible';

export class LocalWhisperSTT implements STTProvider {
  private endpoint: string;
  private model: string;
  private serverType: LocalWhisperServerType;
  private language?: string;

  constructor(
    endpoint: string = 'http://localhost:8080',
    model?: string,
    serverType: LocalWhisperServerType = 'whisper_cpp',
    language?: string,
  ) {
    this.endpoint = endpoint;
    this.model = model ?? 'base';
    this.serverType = serverType;
    this.language = language;
  }

  private resolveUrl(): string {
    const normalized = this.endpoint.replace(/\/+$/, '');
    if (this.serverType === 'whisper_cpp') {
      const hasPath = /\/(inference|asr|transcribe)$/.test(normalized);
      return hasPath ? normalized : `${normalized}/inference`;
    }
    return normalized;
  }

  private buildForm(audio: Buffer): FormData {
    const formData = new FormData();
    if (this.serverType === 'whisper_cpp') {
      formData.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
      formData.append('response_format', 'json');
      formData.append('temperature', '0.0');
      formData.append('temperature_inc', '0.2');
    } else {
      formData.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
      formData.append('model', this.model);
      if (this.language) formData.append('language', this.language);
    }
    return formData;
  }

  private async parseResponse(response: Response): Promise<string> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const result = await response.json() as any;
      return String(
        result.text ??
        result.transcript ??
        result.data?.text ??
        ''
      ).trim();
    }
    return (await response.text()).trim();
  }

  async transcribe(audio: Buffer): Promise<string> {
    const url = this.resolveUrl();
    const formData = this.buildForm(audio);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Local Whisper STT error (${response.status}): ${err}`);
    }

    const transcript = await this.parseResponse(response);
    if (!transcript) {
      throw new Error('Local Whisper STT returned empty transcription');
    }
    return transcript;
  }
}

/**
 * Sarvam AI STT — uses Sarvam's Speech-to-Text API.
 */
export class SarvamSTT implements STTProvider {
  private apiKey: string;
  private model: string;
  private language: string;

  constructor(apiKey: string, model: string = 'saaras:v3', language: string = 'unknown') {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', this.model);
    formData.append('language_code', this.language);

    const response = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Sarvam STT error (${response.status}): ${err}`);
    }

    const result = await response.json() as { transcript?: string; text?: string };
    const transcript = result.transcript ?? result.text;
    if (typeof transcript !== 'string' || !transcript) {
      throw new Error(`Sarvam STT returned no transcript: ${JSON.stringify(result).slice(0, 200)}`);
    }
    return transcript;
  }
}

/**
 * Factory: create the right STT provider from config.
 * Returns null if the selected provider lacks required credentials.
 *
 * `hosted` carries the Usejarvis AI proxy credentials as a SEPARATE argument
 * (see HostedVoiceCredentials): cfg.stt only ever stores the string choice
 * `provider: 'usejarvis'`, so the key can never leak into the persisted
 * plaintext settings row.
 */
export function createSTTProvider(
  config: STTConfig,
  hosted?: HostedVoiceCredentials | null,
): STTProvider | null {
  switch (config.provider) {
    case 'usejarvis':
      if (!hosted?.baseUrl || !hosted?.apiKey) return null;
      return new UsejarvisSTT(hosted.baseUrl, hosted.apiKey, undefined, config.language);
    case 'openai':
      if (!config.openai?.api_key) return null;
      return new OpenAIWhisperSTT(config.openai.api_key, config.openai.model, config.language);
    case 'groq':
      if (!config.groq?.api_key) return null;
      return new GroqWhisperSTT(config.groq.api_key, config.groq.model, config.language);
    case 'local':
      return new LocalWhisperSTT(
        config.local?.endpoint,
        config.local?.model,
        config.local?.server_type,
        config.language,
      );
    case 'sarvam':
      if (!config.sarvam?.api_key) return null;
      return new SarvamSTT(config.sarvam.api_key, config.sarvam.model, config.sarvam.language);
    default:
      return null;
  }
}

/**
 * Edge TTS Provider — uses Microsoft Edge's online TTS service (free, no API key).
 * Runs server-side only (browser WebSocket can't set required headers).
 */
export class EdgeTTSProvider implements TTSProvider {
  private voice: string;
  private rate: string;
  private volume: string;

  constructor(voice = 'en-US-AriaNeural', rate = '+0%', volume = '+0%') {
    this.voice = voice;
    this.rate = rate;
    this.volume = volume;
  }

  async synthesize(text: string): Promise<Buffer> {
    // Lazy-loaded: edge-tts-universal costs ~27MB RSS, only pay it when
    // Edge TTS is actually used, not on daemon boot.
    const { Communicate } = await import('edge-tts-universal');
    const comm = new Communicate(text, {
      voice: this.voice,
      rate: this.rate,
      volume: this.volume,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of comm.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        chunks.push(chunk.data);
      }
    }
    return Buffer.concat(chunks);
  }

  /**
   * Streaming variant: synthesizes text and yields a single complete MP3 buffer.
   * Called per-sentence so the caller can pipeline multiple sentences.
   * Each yielded buffer is a valid, decodable MP3 file.
   */
  async *synthesizeStream(text: string): AsyncIterable<Buffer> {
    // Collect all chunks into a complete MP3 — individual edge-tts
    // fragments are not valid standalone audio files
    const audio = await this.synthesize(text);
    if (audio.length > 0) {
      yield audio;
    }
  }
}

/**
 * ElevenLabs TTS Provider — high-quality personalized voices via ElevenLabs API.
 * Supports true streaming (chunks are valid playable audio).
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  private apiKey: string;
  private voiceId: string;
  private model: string;
  private stability: number;
  private similarityBoost: number;

  constructor(config: NonNullable<TTSConfig['elevenlabs']>) {
    this.apiKey = config.api_key;
    // Voice ids are opaque alphanumeric tokens; anything else (slashes, query
    // chars) would rewrite the request path below, so fall back to the default.
    const voiceId = config.voice_id && /^[A-Za-z0-9_-]{1,64}$/.test(config.voice_id) ? config.voice_id : undefined;
    this.voiceId = voiceId ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)
    this.model = config.model ?? 'eleven_flash_v2_5';
    this.stability = config.stability ?? 0.5;
    this.similarityBoost = config.similarity_boost ?? 0.75;
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: this.model,
          voice_settings: {
            stability: this.stability,
            similarity_boost: this.similarityBoost,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`ElevenLabs TTS error (${response.status}): ${err}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async *synthesizeStream(text: string): AsyncIterable<Buffer> {
    // Collect into a complete MP3 per sentence — individual streaming
    // fragments are not decodable by the browser's AudioContext.decodeAudioData
    const audio = await this.synthesize(text);
    if (audio.length > 0) {
      yield audio;
    }
  }
}

/**
 * Hosted "Usejarvis AI" TTS — the platform proxy's OpenAI-compatible
 * /audio/speech endpoint. `uj-tts` is the stable per-plan alias (resolution
 * happens at the proxy, like uj-stt and the LLM tiers). Credentials come from
 * the system-owned `usejarvis_ai` block via the factory's `hosted` argument —
 * never from cfg.tts.
 */
/** Per-request ceiling for hosted speech. Generous for a spoken sentence,
 * bounded for a reply that never split. */
const MAX_TTS_INPUT_CHARS = 4_000;
/** Hard cap on one synthesis round-trip — see the call site. */
const TTS_TIMEOUT_MS = 30_000;

/** MP3 frame sniff: an ID3 tag, or an MPEG audio sync word (0xFF Ex). Used to
 * accept a correct response whose content-type header a proxy stripped or
 * rewrote, so the guard rejects interstitials without rejecting real audio. */
function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  return buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0;
}

export class UsejarvisTTS implements TTSProvider {
  private baseUrl: string;
  private apiKey: string;
  private voice: string;

  constructor(baseUrl: string, apiKey: string, voice: string = 'alloy') {
    // Same origin→/v1 normalization as UsejarvisSTT / UsejarvisAIProvider.
    const trimmed = baseUrl.replace(/\/+$/, '');
    this.baseUrl = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    this.apiKey = apiKey;
    this.voice = voice;
  }

  async synthesize(text: string): Promise<Buffer> {
    // Cap the input. splitIntoSentences returns the WHOLE text as one
    // "sentence" when it cannot find a boundary (a long bullet list, a URL
    // dump), and this endpoint is billed per CHARACTER — so an unsplittable
    // reply would bill in one unbounded request. Truncating costs a clipped
    // tail; not truncating costs real money on a runaway generation.
    let input = text;
    if (text.length > MAX_TTS_INPUT_CHARS) {
      let cut = MAX_TTS_INPUT_CHARS;
      // Never split a surrogate pair — a lone surrogate is invalid JSON string
      // content for the proxy.
      const last = text.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
      input = text.slice(0, cut);
      console.warn(`[UsejarvisTTS] Input truncated from ${text.length} to ${input.length} chars (per-request cap; the spoken reply will cut off)`);
    }

    const response = await fetch(`${this.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'uj-tts',
        input,
        voice: this.voice,
        response_format: 'mp3',
      }),
      // A hung proxy must not wedge the sentence queue: ws-service speaks
      // sentences in sequence, so one stalled request silences everything
      // after it with no error and no timeout of its own.
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });

    if (!response.ok) {
      const err = await response.text();
      // Shared mapper, same reasoning as the STT branch: /api/tts/preview
      // returns err.message straight to the settings toast, so budget and
      // plan failures must read as copy, not as proxy JSON.
      throw hostedProxyError('Usejarvis AI TTS', response.status, err);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audio = Buffer.from(arrayBuffer);

    // A 200 that isn't audio is the SAME class as UsejarvisSTT's
    // no-transcript branch: a proxy or CDN interstitial is exactly where an
    // echoed bearer shows up. Without this check the HTML would be returned
    // AS the MP3 — nothing throws, so redaction never runs, and the preview
    // route ships it to the browser labelled audio/mpeg with the key inside.
    // Empty stays a no-op (callers already treat it as "nothing to speak");
    // an interstitial always carries bytes, so the guard loses nothing.
    const contentType = response.headers.get('content-type') ?? '';
    if (audio.length > 0 && !contentType.toLowerCase().startsWith('audio/') && !looksLikeMp3(audio)) {
      const body = audio.subarray(0, 2048).toString('utf8');
      throw new Error(
        `Usejarvis AI TTS returned a non-audio body (content-type: ${contentType || 'none'}): ` +
          `${redactSecrets(body).slice(0, 200)}`,
      );
    }
    return audio;
  }

  async *synthesizeStream(text: string): AsyncIterable<Buffer> {
    // Same fake-streaming shape as the other providers: one complete MP3 per
    // sentence, so the browser's decodeAudioData always gets a valid file.
    const audio = await this.synthesize(text);
    if (audio.length > 0) {
      yield audio;
    }
  }
}

/**
 * Sarvam AI TTS Provider — high-quality Indian language voices via Sarvam AI.
 */
export class SarvamTTSProvider implements TTSProvider {
  private apiKey: string;
  private model: string;
  private language: string;
  private speaker: string;
  private samplingRate: number;

  constructor(config: NonNullable<TTSConfig['sarvam']>) {
    this.apiKey = config.api_key;
    this.model = config.model ?? 'bulbul:v3';
    this.language = config.language ?? 'en-IN';
    this.speaker = config.speaker ?? 'anushka';
    this.samplingRate = config.sampling_rate ?? 48000;
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model: this.model,
        target_language_code: this.language,
        speaker: this.speaker,
        speech_sample_rate: this.samplingRate,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Sarvam TTS error (${response.status}): ${err}`);
    }

    const result = await response.json() as any;
    const base64Audio = result.audio_content || (result.audios && result.audios[0]);
    if (base64Audio) {
      return Buffer.from(base64Audio, 'base64');
    }
    throw new Error('Sarvam TTS returned no audio content');
  }

  async *synthesizeStream(text: string): AsyncIterable<Buffer> {
    const audio = await this.synthesize(text);
    if (audio.length > 0) {
      yield audio;
    }
  }
}

/**
 * Fetch available voices from ElevenLabs API.
 */
export async function listElevenLabsVoices(apiKey: string): Promise<{
  voice_id: string;
  name: string;
  category: string;
}[]> {
  const response = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs voices error (${response.status}): ${err}`);
  }

  const data = await response.json() as any;
  return (data.voices ?? []).map((v: any) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category ?? 'unknown',
  }));
}

/**
 * Factory: create the right TTS provider from config.
 * Returns null if TTS is disabled.
 *
 * `hosted` is the same separate credential channel as createSTTProvider's:
 * cfg.tts only ever stores the string choice `provider: 'usejarvis'`.
 */
export function createTTSProvider(
  config: TTSConfig,
  hosted?: HostedVoiceCredentials | null,
): TTSProvider | null {
  if (!config.enabled) return null;

  if (config.provider === 'usejarvis') {
    if (!hosted?.baseUrl || !hosted?.apiKey) return null;
    // Reuse a configured voice only when it isn't an Edge neural name:
    // cfg.tts.voice defaults to 'en-US-AriaNeural' (Edge-specific), which the
    // OpenAI-compatible proxy would reject — those fall back to 'alloy'.
    const voice = config.voice && !/Neural$/i.test(config.voice) ? config.voice : undefined;
    return new UsejarvisTTS(hosted.baseUrl, hosted.apiKey, voice ?? 'alloy');
  }

  if (config.provider === 'elevenlabs') {
    if (!config.elevenlabs?.api_key) return null;
    return new ElevenLabsTTSProvider(config.elevenlabs);
  }

  if (config.provider === 'sarvam') {
    if (!config.sarvam?.api_key) return null;
    return new SarvamTTSProvider(config.sarvam);
  }

  // Default: Edge TTS
  return new EdgeTTSProvider(config.voice, config.rate, config.volume);
}

/**
 * Split text into sentences for streaming TTS.
 * Each sentence is synthesized and played independently for low latency.
 */
export function splitIntoSentences(text: string): string[] {
  // Collapse code blocks to avoid splitting on periods inside code
  const collapsed = text.replace(/```[\s\S]*?```/g, '[code block]');
  // Split on sentence-ending punctuation followed by whitespace + capital letter,
  // or on double newlines (paragraph breaks)
  const sentences = collapsed
    .split(/(?<=[.!?])\s+(?=[A-Z])|(?<=\n\n)/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return sentences.length > 0 ? sentences : [text];
}
