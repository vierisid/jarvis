import { test, expect, describe, mock, afterEach } from 'bun:test';
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

/** Build a minimal valid WAV buffer */
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

  test('passes server_type through to LocalWhisperSTT', () => {
    const config: STTConfig = {
      provider: 'local',
      local: { endpoint: 'http://my-server:9000', server_type: 'openai_compatible' },
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
// LocalWhisperSTT – transcribe() tests
// ---------------------------------------------------------------------------

describe('LocalWhisperSTT.transcribe', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -- Server type defaults ------------------------------------------------

  test('defaults to whisper_cpp server type', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async (_url: string, init: any) => {
      const body = init.body as FormData;
      expect(body.has('response_format')).toBe(true);
      expect(body.has('model')).toBe(false);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
  });

  // -- whisper_cpp mode ----------------------------------------------------

  test('whisper_cpp: appends /inference to bare-host endpoint', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();
    let calledUrl = '';

    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(calledUrl).toBe('http://localhost:8189/inference');
  });

  test('whisper_cpp: uses endpoint as-is when it has explicit path', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();
    let calledUrl = '';

    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(calledUrl).toBe('http://localhost:8189/inference');
  });

  test('whisper_cpp: strips trailing slashes from endpoint', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189///');
    const wav = makeWavBuffer();
    let calledUrl = '';

    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(calledUrl).toBe('http://localhost:8189/inference');
  });

  test('whisper_cpp: sends response_format and temperature fields', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference', undefined, 'whisper_cpp');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async (_url: string, init: any) => {
      const body = init.body as FormData;
      expect(body.has('response_format')).toBe(true);
      expect(body.get('response_format')).toBe('json');
      expect(body.has('temperature')).toBe(true);
      expect(body.has('model')).toBe(false);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
  });

  // -- openai_compatible mode ----------------------------------------------

  test('openai_compatible: uses endpoint verbatim', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8080/v1/audio/transcriptions', undefined, 'openai_compatible');
    const wav = makeWavBuffer();
    let calledUrl = '';

    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(calledUrl).toBe('http://localhost:8080/v1/audio/transcriptions');
  });

  test('openai_compatible: sends model and language fields', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8080/v1/audio/transcriptions', 'whisper-1', 'openai_compatible');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async (_url: string, init: any) => {
      const body = init.body as FormData;
      expect(body.has('model')).toBe(true);
      expect(body.get('model')).toBe('whisper-1');
      expect(body.has('language')).toBe(true);
      expect(body.has('response_format')).toBe(false);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
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

  // -- Error handling -----------------------------------------------------

  test('throws on HTTP error with status and body', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response('server error', { status: 500 })
    ) as any;

    try {
      await stt.transcribe(wav);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('Local Whisper STT error');
      expect(err.message).toContain('500');
    }
  });

  test('throws on empty transcription', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ text: '' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    try {
      await stt.transcribe(wav);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain('empty transcription');
    }
  });

  test('propagates network errors', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8189/inference');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () => {
      throw new Error('Connection refused');
    }) as any;

    try {
      await stt.transcribe(wav);
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toBe('Connection refused');
    }
  });
});
