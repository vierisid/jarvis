import type { STTConfig, TTSConfig } from '../config/types.ts';
import { Communicate } from 'edge-tts-universal';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface STTProvider {
  transcribe(audio: Buffer): Promise<string>;
}

export interface TTSProvider {
  synthesize(text: string): Promise<Buffer>;
  synthesizeStream(text: string): AsyncIterable<Buffer>;
}

/**
 * OpenAI Whisper STT — uses the OpenAI /v1/audio/transcriptions endpoint.
 */
export class OpenAIWhisperSTT implements STTProvider {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = 'whisper-1') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/webm' }), 'audio.webm');
    formData.append('model', this.model);
    formData.append('language', 'en');

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

  constructor(apiKey: string, model: string = 'whisper-large-v3-turbo') {
    this.apiKey = apiKey;
    this.model = model;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/webm' }), 'audio.webm');
    formData.append('model', this.model);
    formData.append('language', 'en');

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
 * Local Whisper STT — connects to a whisper.cpp HTTP server or compatible endpoint.
 */
export class LocalWhisperSTT implements STTProvider {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string = 'http://localhost:8080', model?: string) {
    this.endpoint = endpoint;
    this.model = model ?? 'base';
  }

  private isWav(audio: Buffer): boolean {
    return audio.length >= 12 &&
      audio.subarray(0, 4).toString('ascii') === 'RIFF' &&
      audio.subarray(8, 12).toString('ascii') === 'WAVE';
  }

  private buildCandidateUrls(): string[] {
    const normalized = this.endpoint.replace(/\/+$/, '');
    const looksLikeExplicitPath = /\/(inference|asr|transcribe|audio\/transcriptions)$/.test(normalized);
    return looksLikeExplicitPath
      ? [normalized]
      : [`${normalized}/inference`, normalized];
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

  private async transcodeToWav(audio: Buffer): Promise<Buffer> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = join(tmpdir(), `jarvis-voice-${id}.webm`);
    const outputPath = join(tmpdir(), `jarvis-voice-${id}.wav`);

    await Bun.write(inputPath, audio);

    const proc = Bun.spawn([
      'ffmpeg',
      '-y',
      '-i', inputPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      outputPath,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    try { await unlink(inputPath); } catch {}

    if (exitCode !== 0) {
      throw new Error(`ffmpeg conversion failed (${exitCode}): ${stderr.trim()}`);
    }

    const wav = Buffer.from(await Bun.file(outputPath).arrayBuffer());
    try { await unlink(outputPath); } catch {}
    return wav;
  }

  private buildOpenAICompatibleForm(audio: Buffer): FormData {
    const audioBlob = new Blob([new Uint8Array(audio)], { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', this.model);
    formData.append('language', 'en');
    return formData;
  }

  private buildWhisperCppForm(audio: Buffer): FormData {
    const audioBlob = new Blob([new Uint8Array(audio)], { type: 'audio/wav' });
    const whisperCppForm = new FormData();
    whisperCppForm.append('file', audioBlob, 'audio.wav');
    whisperCppForm.append('response_format', 'json');
    whisperCppForm.append('temperature', '0.0');
    whisperCppForm.append('temperature_inc', '0.2');
    return whisperCppForm;
  }

  async transcribe(audio: Buffer): Promise<string> {
    const errors: string[] = [];
    let whisperCppAudio: Buffer | null = null;

    if (this.isWav(audio)) {
      whisperCppAudio = audio;
    } else {
      try {
        whisperCppAudio = await this.transcodeToWav(audio);
      } catch (err) {
        errors.push(`ffmpeg conversion -> ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const url of this.buildCandidateUrls()) {
      const requestBodies: Array<{ label: string; formData: FormData }> = [];
      if (whisperCppAudio) {
        requestBodies.push({ label: 'whisper.cpp', formData: this.buildWhisperCppForm(whisperCppAudio) });
      }
      requestBodies.push({ label: 'openai-compatible', formData: this.buildOpenAICompatibleForm(audio) });

      for (const { label: requestLabel, formData } of requestBodies) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            body: formData,
          });

          if (!response.ok) {
            const err = await response.text();
            errors.push(`${url} (${requestLabel}) -> ${response.status}: ${err}`);
            continue;
          }

          const transcript = await this.parseResponse(response);
          if (transcript) return transcript;

          errors.push(`${url} (${requestLabel}) -> empty transcription response`);
        } catch (err) {
          errors.push(`${url} (${requestLabel}) -> ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    throw new Error(`Local Whisper STT failed. Tried: ${errors.join(' | ')}`);
  }
}

/**
 * Factory: create the right STT provider from config.
 * Returns null if the selected provider lacks required credentials.
 */
export function createSTTProvider(config: STTConfig): STTProvider | null {
  switch (config.provider) {
    case 'openai':
      if (!config.openai?.api_key) return null;
      return new OpenAIWhisperSTT(config.openai.api_key, config.openai.model);
    case 'groq':
      if (!config.groq?.api_key) return null;
      return new GroqWhisperSTT(config.groq.api_key, config.groq.model);
    case 'local':
      return new LocalWhisperSTT(config.local?.endpoint, config.local?.model);
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
    this.voiceId = config.voice_id ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel (default)
    this.model = config.model ?? 'eleven_flash_v2_5';
    this.stability = config.stability ?? 0.5;
    this.similarityBoost = config.similarity_boost ?? 0.75;
  }

  async synthesize(text: string): Promise<Buffer> {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream?output_format=mp3_44100_128`,
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
 */
export function createTTSProvider(config: TTSConfig): TTSProvider | null {
  if (!config.enabled) return null;

  if (config.provider === 'elevenlabs') {
    if (!config.elevenlabs?.api_key) return null;
    return new ElevenLabsTTSProvider(config.elevenlabs);
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
