import { test, expect, describe, mock, afterEach, beforeEach } from 'bun:test';
import {
  createSTTProvider,
  createTTSProvider,
  OpenAIWhisperSTT,
  GroqWhisperSTT,
  LocalWhisperSTT,
  EdgeTTSProvider,
  splitIntoSentences,
} from './voice.ts';
import type { STTConfig, TTSConfig } from '../config/types.ts';

/** Build a minimal valid WAV buffer so LocalWhisperSTT.isWav() returns true */
function makeWavBuffer(pcmBytes = 100): Buffer {
  const dataSize = pcmBytes;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);       // subchunk1 size
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(16000, 24);    // sample rate
  buf.writeUInt32LE(32000, 28);    // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('createSTTProvider factory', () => {
  test('returns OpenAIWhisperSTT when provider=openai and key present', () => {
    const config: STTConfig = {
      provider: 'openai',
      openai: { api_key: 'test-openai-key-not-real' },
    };
    const provider = createSTTProvider(config);
    expect(provider).toBeInstanceOf(OpenAIWhisperSTT);
  });

  test('returns null when provider=openai and no key', () => {
    const config: STTConfig = { provider: 'openai' };
    const provider = createSTTProvider(config);
    expect(provider).toBeNull();
  });

  test('returns GroqWhisperSTT when provider=groq and key present', () => {
    const config: STTConfig = {
      provider: 'groq',
      groq: { api_key: 'gtest-openai-key-not-real' },
    };
    const provider = createSTTProvider(config);
    expect(provider).toBeInstanceOf(GroqWhisperSTT);
  });

  test('returns null when provider=groq and no key', () => {
    const config: STTConfig = { provider: 'groq' };
    const provider = createSTTProvider(config);
    expect(provider).toBeNull();
  });

  test('returns LocalWhisperSTT when provider=local (no key needed)', () => {
    const config: STTConfig = { provider: 'local' };
    const provider = createSTTProvider(config);
    expect(provider).toBeInstanceOf(LocalWhisperSTT);
  });

  test('returns LocalWhisperSTT with custom endpoint', () => {
    const config: STTConfig = {
      provider: 'local',
      local: { endpoint: 'http://my-server:9000' },
    };
    const provider = createSTTProvider(config);
    expect(provider).toBeInstanceOf(LocalWhisperSTT);
  });

  test('returns null for unknown provider', () => {
    const config = { provider: 'unknown' } as any;
    const provider = createSTTProvider(config);
    expect(provider).toBeNull();
  });

  test('returns OpenAI with custom model', () => {
    const config: STTConfig = {
      provider: 'openai',
      openai: { api_key: 'test-key-not-real', model: 'whisper-large-v3' },
    };
    const provider = createSTTProvider(config);
    expect(provider).toBeInstanceOf(OpenAIWhisperSTT);
  });
});

describe('createTTSProvider factory', () => {
  test('returns null when tts disabled', () => {
    const config: TTSConfig = { enabled: false };
    expect(createTTSProvider(config)).toBeNull();
  });

  test('returns EdgeTTSProvider when enabled', () => {
    const config: TTSConfig = { enabled: true };
    const provider = createTTSProvider(config);
    expect(provider).toBeInstanceOf(EdgeTTSProvider);
  });

  test('passes voice config to provider', () => {
    const config: TTSConfig = { enabled: true, voice: 'en-GB-SoniaNeural' };
    const provider = createTTSProvider(config);
    expect(provider).toBeInstanceOf(EdgeTTSProvider);
  });

  test('passes rate and volume config', () => {
    const config: TTSConfig = { enabled: true, rate: '+20%', volume: '-10%' };
    const provider = createTTSProvider(config);
    expect(provider).not.toBeNull();
  });
});

describe('EdgeTTSProvider', () => {
  test('implements TTSProvider interface', () => {
    const provider = new EdgeTTSProvider();
    expect(typeof provider.synthesize).toBe('function');
    expect(typeof provider.synthesizeStream).toBe('function');
  });

  test('constructor accepts custom voice/rate/volume', () => {
    const provider = new EdgeTTSProvider('en-GB-SoniaNeural', '+10%', '-5%');
    expect(provider).toBeInstanceOf(EdgeTTSProvider);
  });
});

describe('splitIntoSentences', () => {
  test('splits on period + capital letter', () => {
    const result = splitIntoSentences('Hello there. World is great. This works.');
    expect(result.length).toBe(3);
    expect(result[0]).toBe('Hello there.');
    expect(result[1]).toBe('World is great.');
    expect(result[2]).toBe('This works.');
  });

  test('splits on exclamation and question marks', () => {
    const result = splitIntoSentences('Wait! Are you sure? Yes I am.');
    expect(result.length).toBe(3);
  });

  test('handles single sentence', () => {
    const result = splitIntoSentences('Just one sentence.');
    expect(result).toEqual(['Just one sentence.']);
  });

  test('handles empty string', () => {
    const result = splitIntoSentences('');
    expect(result).toEqual(['']);
  });

  test('collapses code blocks', () => {
    const result = splitIntoSentences('Here is code:\n```\nconst x = 1;\n```\nDone.');
    // Should not split inside code block
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('splits on double newlines (paragraph breaks)', () => {
    const result = splitIntoSentences('First paragraph\n\nSecond paragraph');
    expect(result.length).toBe(2);
  });

  test('handles text with no sentence-ending punctuation', () => {
    const result = splitIntoSentences('just some words without punctuation');
    expect(result).toEqual(['just some words without punctuation']);
  });
});

// ---------------------------------------------------------------------------
// LocalWhisperSTT – transcribe() integration tests
// ---------------------------------------------------------------------------

describe('LocalWhisperSTT.transcribe', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -- WAV detection & skipping transcode ----------------------------------

  test('skips transcoding when audio has RIFF/WAVE header', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: 'hello' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    const result = await stt.transcribe(wav);
    expect(result).toBe('hello');
  });

  // -- Candidate URL generation -------------------------------------------

  test('tries /inference first for bare-host endpoint', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();
    const calledUrls: string[] = [];

    globalThis.fetch = mock(async (url: string) => {
      calledUrls.push(url);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(calledUrls[0]).toBe('http://localhost:8189/inference');
  });

  test('uses single URL when endpoint already has explicit path', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();
    const calledUrls: string[] = [];

    globalThis.fetch = mock(async (url: string) => {
      calledUrls.push(url);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    // Should only call the explicit URL, not append /inference again
    expect(calledUrls.every(u => u === 'http://localhost:8189/inference')).toBe(true);
  });

  test('strips trailing slashes from endpoint', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189///');
    const wav = makeWavBuffer();
    const calledUrls: string[] = [];

    globalThis.fetch = mock(async (url: string) => {
      calledUrls.push(url);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(calledUrls[0]).toBe('http://localhost:8189/inference');
  });

  // -- Response shape parsing ---------------------------------------------

  test('parses JSON response with "text" field', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: 'hello world' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    expect(await stt.transcribe(wav)).toBe('hello world');
  });

  test('parses JSON response with "transcript" field', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ transcript: 'transcript field' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    expect(await stt.transcribe(wav)).toBe('transcript field');
  });

  test('parses JSON response with nested "data.text" field', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ data: { text: 'nested text' } }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    expect(await stt.transcribe(wav)).toBe('nested text');
  });

  test('parses plain-text response body', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response('plain text result', {
        headers: { 'content-type': 'text/plain' },
      })
    ) as any;

    expect(await stt.transcribe(wav)).toBe('plain text result');
  });

  test('trims whitespace from transcription result', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: '  hello  \n' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    expect(await stt.transcribe(wav)).toBe('hello');
  });

  // -- Fallback & retry logic ---------------------------------------------

  test('falls back to bare endpoint when /inference returns error', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();
    const calledUrls: string[] = [];

    globalThis.fetch = mock(async (url: string) => {
      calledUrls.push(url);
      if (url.includes('/inference')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({ text: 'fallback worked' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const result = await stt.transcribe(wav);
    expect(result).toBe('fallback worked');
    expect(calledUrls.some(u => u === 'http://localhost:8189')).toBe(true);
  });

  test('tries whisper.cpp form before openai-compatible form', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();
    let callIndex = 0;
    const formLabels: string[] = [];

    globalThis.fetch = mock(async (_url: string, init: any) => {
      callIndex++;
      const body = init.body as FormData;
      // whisper.cpp form has response_format; openai-compatible has model
      if (body.has('response_format')) {
        formLabels.push('whisper.cpp');
      } else if (body.has('model')) {
        formLabels.push('openai-compatible');
      }
      // Only succeed on second call
      if (callIndex === 1) {
        return new Response('bad', { status: 400 });
      }
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(formLabels[0]).toBe('whisper.cpp');
    expect(formLabels[1]).toBe('openai-compatible');
  });

  // -- Error aggregation --------------------------------------------------

  test('throws aggregated error when all attempts fail', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response('server error', { status: 500 })
    ) as any;

    try {
      await stt.transcribe(wav);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain('Local Whisper STT failed');
      expect(err.message).toContain('500');
    }
  });

  test('includes network errors in aggregated error message', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () => {
      throw new Error('Connection refused');
    }) as any;

    try {
      await stt.transcribe(wav);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Local Whisper STT failed');
      expect(err.message).toContain('Connection refused');
    }
  });

  test('treats empty transcription as failure and continues trying', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();
    let callCount = 0;

    globalThis.fetch = mock(async () => {
      callCount++;
      // First two calls return empty, last one returns real text
      if (callCount <= 1) {
        return new Response(JSON.stringify({ text: '' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ text: 'finally got it' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    const result = await stt.transcribe(wav);
    expect(result).toBe('finally got it');
    expect(callCount).toBeGreaterThan(1);
  });

  // -- Non-WAV audio (ffmpeg path) ----------------------------------------

  test('attempts ffmpeg transcode for non-WAV audio and includes error on failure', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const nonWav = Buffer.from('not a wav file at all');

    // fetch always fails too, so we get the aggregated error
    globalThis.fetch = mock(async () =>
      new Response('error', { status: 500 })
    ) as any;

    try {
      await stt.transcribe(nonWav);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Local Whisper STT failed');
      // Should still have tried the openai-compatible form even without WAV
      expect(err.message).toContain('openai-compatible');
    }
  });
});
