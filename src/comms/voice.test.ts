import { test, expect, describe, mock, afterEach } from 'bun:test';
import {
  createSTTProvider,
  createTTSProvider,
  OpenAIWhisperSTT,
  GroqWhisperSTT,
  LocalWhisperSTT,
  SarvamSTT,
  UsejarvisSTT,
  UsejarvisTTS,
  EdgeTTSProvider,
  SarvamTTSProvider,
  sniffAudioFormat,
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

/** Build a minimal OGG-page-prefixed buffer (Telegram voice-note container). */
function makeOggBuffer(payloadBytes = 64): Buffer {
  const buf = Buffer.alloc(4 + payloadBytes);
  buf.write('OggS', 0, 'ascii');
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

  test('returns SarvamSTT when provider=sarvam and key present', () => {
    const config: STTConfig = {
      provider: 'sarvam',
      sarvam: { api_key: 'sk_test_not_real' },
    };
    expect(createSTTProvider(config)).toBeInstanceOf(SarvamSTT);
  });

  test('returns null when provider=sarvam and no key', () => {
    const config: STTConfig = { provider: 'sarvam' };
    expect(createSTTProvider(config)).toBeNull();
  });

  test('returns UsejarvisSTT when provider=usejarvis and hosted creds passed', () => {
    const config: STTConfig = { provider: 'usejarvis' };
    const provider = createSTTProvider(config, {
      baseUrl: 'https://llm.usejarvis.host',
      apiKey: 'sk-uj-not-real',
    });
    expect(provider).toBeInstanceOf(UsejarvisSTT);
  });

  test('returns null when provider=usejarvis and no hosted creds (self-hosted)', () => {
    const config: STTConfig = { provider: 'usejarvis' };
    expect(createSTTProvider(config)).toBeNull();
    expect(createSTTProvider(config, null)).toBeNull();
    expect(createSTTProvider(config, { baseUrl: '', apiKey: 'sk-uj-not-real' })).toBeNull();
    expect(createSTTProvider(config, { baseUrl: 'https://llm.usejarvis.host', apiKey: '' })).toBeNull();
  });

  test('cfg.stt sub-blocks never feed the usejarvis case (key stays out of user config)', () => {
    // Even a squatting sub-block in the persisted user section is ignored:
    // only the separately-threaded hosted argument can supply credentials.
    const config = { provider: 'usejarvis', usejarvis: { api_key: 'from-db-row' } } as unknown as STTConfig;
    expect(createSTTProvider(config)).toBeNull();
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

  test('returns SarvamTTSProvider when provider=sarvam and key present', () => {
    const config: TTSConfig = {
      enabled: true,
      provider: 'sarvam',
      sarvam: { api_key: 'sk_test_not_real' },
    };
    expect(createTTSProvider(config)).toBeInstanceOf(SarvamTTSProvider);
  });

  test('returns null when provider=sarvam and no key', () => {
    const config: TTSConfig = { enabled: true, provider: 'sarvam' };
    expect(createTTSProvider(config)).toBeNull();
  });

  test('returns UsejarvisTTS when provider=usejarvis and hosted creds passed', () => {
    const config: TTSConfig = { enabled: true, provider: 'usejarvis' };
    const provider = createTTSProvider(config, {
      baseUrl: 'https://llm.usejarvis.host',
      apiKey: 'sk-uj-not-real',
    });
    expect(provider).toBeInstanceOf(UsejarvisTTS);
  });

  test('returns null when provider=usejarvis and no hosted creds (self-hosted)', () => {
    const config: TTSConfig = { enabled: true, provider: 'usejarvis' };
    expect(createTTSProvider(config)).toBeNull();
    expect(createTTSProvider(config, null)).toBeNull();
    expect(createTTSProvider(config, { baseUrl: '', apiKey: 'sk-uj-not-real' })).toBeNull();
  });

  test('returns null for usejarvis when tts disabled, even with creds', () => {
    const config: TTSConfig = { enabled: false, provider: 'usejarvis' };
    expect(createTTSProvider(config, { baseUrl: 'https://llm.usejarvis.host', apiKey: 'k' })).toBeNull();
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

  test('openai_compatible: sends model, omits language unless configured', async () => {
    const stt = new LocalWhisperSTT('http://localhost:8080/v1/audio/transcriptions', 'whisper-1', 'openai_compatible');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async (_url: string, init: any) => {
      const body = init.body as FormData;
      expect(body.has('model')).toBe(true);
      expect(body.get('model')).toBe('whisper-1');
      // Unset language = auto-detect: the param is omitted entirely.
      expect(body.has('language')).toBe(false);
      expect(body.has('response_format')).toBe(false);
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);

    globalThis.fetch = mock(async (_url: string, init: any) => {
      expect((init.body as FormData).get('language')).toBe('it');
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
    const withLang = new LocalWhisperSTT('http://localhost:8080/v1/audio/transcriptions', 'whisper-1', 'openai_compatible', 'it');
    await withLang.transcribe(wav);
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

describe('UsejarvisSTT.transcribe', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('POSTs multipart WAV to <origin>/v1/audio/transcriptions with bearer + uj-stt', async () => {
    const stt = new UsejarvisSTT('https://llm.usejarvis.host', 'sk-uj-not-real');
    const wav = makeWavBuffer();
    let calledUrl = '';
    let auth = '';
    let model = '';
    let file: File | null = null;

    globalThis.fetch = mock(async (url: string, init: any) => {
      calledUrl = url;
      auth = init.headers['Authorization'];
      const body = init.body as FormData;
      model = String(body.get('model'));
      file = body.get('file') as File;
      return new Response(JSON.stringify({ text: 'hosted transcript' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    expect(await stt.transcribe(wav)).toBe('hosted transcript');
    expect(calledUrl).toBe('https://llm.usejarvis.host/v1/audio/transcriptions');
    expect(auth).toBe('Bearer sk-uj-not-real');
    expect(model).toBe('uj-stt');
    // The browser mic sends WAV — the form must say so (the audio.webm
    // mislabel made strict servers reject the part).
    expect(file!.name).toBe('audio.wav');
    expect(file!.type).toBe('audio/wav');
  });

  test('does not double the /v1 prefix when the base already carries it', async () => {
    const stt = new UsejarvisSTT('https://llm.usejarvis.host/v1/', 'sk-uj-not-real');
    let calledUrl = '';

    globalThis.fetch = mock(async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(makeWavBuffer());
    expect(calledUrl).toBe('https://llm.usejarvis.host/v1/audio/transcriptions');
  });

  test('throws with status on HTTP error', async () => {
    const stt = new UsejarvisSTT('https://llm.usejarvis.host', 'sk-uj-not-real');
    globalThis.fetch = mock(async () => new Response('no active plan', { status: 403 })) as any;
    await expect(stt.transcribe(makeWavBuffer())).rejects.toThrow(/Usejarvis AI STT error \(403\)/);
  });

  test('throws when the response carries no text field', async () => {
    const stt = new UsejarvisSTT('https://llm.usejarvis.host', 'sk-uj-not-real');
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;
    await expect(stt.transcribe(makeWavBuffer())).rejects.toThrow('Usejarvis AI STT returned no transcript');
  });
});

describe('sniffAudioFormat', () => {
  test('detects the containers the STT paths actually see', () => {
    expect(sniffAudioFormat(makeWavBuffer())).toEqual({ filename: 'audio.wav', mimeType: 'audio/wav' });
    expect(sniffAudioFormat(makeOggBuffer())).toEqual({ filename: 'audio.ogg', mimeType: 'audio/ogg' });
    expect(sniffAudioFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00])))
      .toEqual({ filename: 'audio.webm', mimeType: 'audio/webm' });
    expect(sniffAudioFormat(Buffer.from('ID3\x04\x00\x00', 'latin1')))
      .toEqual({ filename: 'audio.mp3', mimeType: 'audio/mpeg' });
    expect(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]))) // bare MPEG frame sync
      .toEqual({ filename: 'audio.mp3', mimeType: 'audio/mpeg' });
  });

  test('falls back to WAV (the dashboard-mic format) for unknown or tiny buffers', () => {
    expect(sniffAudioFormat(Buffer.from('????garbage'))).toEqual({ filename: 'audio.wav', mimeType: 'audio/wav' });
    expect(sniffAudioFormat(Buffer.from([0x00]))).toEqual({ filename: 'audio.wav', mimeType: 'audio/wav' });
    expect(sniffAudioFormat(Buffer.alloc(0))).toEqual({ filename: 'audio.wav', mimeType: 'audio/wav' });
  });
});

describe('UsejarvisTTS', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]); // ID3v4 header

  test('POSTs JSON to <origin>/v1/audio/speech with bearer, uj-tts and mp3 format', async () => {
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real');
    let calledUrl = '';
    let auth = '';
    let contentType = '';
    let sentBody: Record<string, unknown> = {};

    globalThis.fetch = mock(async (url: string, init: any) => {
      calledUrl = url;
      auth = init.headers['Authorization'];
      contentType = init.headers['Content-Type'];
      sentBody = JSON.parse(init.body as string);
      return new Response(mp3Bytes);
    }) as any;

    const audio = await tts.synthesize('Hello there.');
    expect(calledUrl).toBe('https://llm.usejarvis.host/v1/audio/speech');
    expect(auth).toBe('Bearer sk-uj-not-real');
    expect(contentType).toBe('application/json');
    expect(sentBody).toEqual({
      model: 'uj-tts',
      input: 'Hello there.',
      voice: 'alloy', // constructor default
      response_format: 'mp3',
    });
    expect(Buffer.compare(audio, Buffer.from(mp3Bytes))).toBe(0);
  });

  test('does not double the /v1 prefix when the base already carries it', async () => {
    const tts = new UsejarvisTTS('https://llm.usejarvis.host/v1', 'sk-uj-not-real');
    let calledUrl = '';
    globalThis.fetch = mock(async (url: string) => { calledUrl = url; return new Response(mp3Bytes); }) as any;
    await tts.synthesize('hi');
    expect(calledUrl).toBe('https://llm.usejarvis.host/v1/audio/speech');
  });

  test('synthesizeStream yields the complete MP3 exactly once', async () => {
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real');
    globalThis.fetch = mock(async () => new Response(mp3Bytes)) as any;
    const chunks: Buffer[] = [];
    for await (const chunk of tts.synthesizeStream('Hello.')) chunks.push(chunk);
    expect(chunks.length).toBe(1);
    expect(Buffer.compare(chunks[0]!, Buffer.from(mp3Bytes))).toBe(0);
  });

  test('synthesizeStream yields nothing for empty audio', async () => {
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real');
    globalThis.fetch = mock(async () => new Response(new Uint8Array(0))) as any;
    const chunks: Buffer[] = [];
    for await (const chunk of tts.synthesizeStream('Hello.')) chunks.push(chunk);
    expect(chunks.length).toBe(0);
  });

  test('throws with status on HTTP error', async () => {
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real');
    globalThis.fetch = mock(async () => new Response('budget exceeded', { status: 429 })) as any;
    await expect(tts.synthesize('hi')).rejects.toThrow(/Usejarvis AI TTS error \(429\)/);
  });

  // A 200 that isn't audio is the same class as the STT no-transcript branch:
  // without this guard the interstitial is returned AS the MP3, nothing
  // throws, redaction never runs, and /api/tts/preview hands the browser a
  // file with the per-account key inside it, labelled audio/mpeg.
  test('rejects a 200 carrying a CDN interstitial instead of returning it as audio', async () => {
    const key = 'sk-uj-LIFETIMEKEY0000000000';
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', key);
    globalThis.fetch = mock(async () => new Response(
      `<html><body>Access denied. token=${key} for llm.usejarvis.host</body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )) as any;
    const err = await tts.synthesize('Hello.').then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('non-audio body');
    expect(err!.message).not.toContain(key);
  });

  // Per-CHARACTER billing plus splitIntoSentences returning the whole text as
  // one "sentence" when it cannot split = an unbounded billable request.
  test('caps the input so an unsplittable reply cannot bill unbounded', async () => {
    let sentLength = 0;
    globalThis.fetch = mock(async (_url: string, init: any) => {
      sentLength = String(JSON.parse(init.body as string).input).length;
      return new Response(mp3Bytes);
    }) as any;
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real');
    await tts.synthesize('x'.repeat(50_000));
    expect(sentLength).toBeLessThanOrEqual(4_000);
    expect(sentLength).toBeGreaterThan(0);
  });

  test('sends an abort signal so a hung proxy cannot wedge the sentence queue', async () => {
    let hadSignal = false;
    globalThis.fetch = mock(async (_url: string, init: any) => {
      hadSignal = init.signal instanceof AbortSignal;
      return new Response(mp3Bytes);
    }) as any;
    await new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real').synthesize('hi');
    expect(hadSignal).toBe(true);
  });

  test('accepts real audio whose content-type a proxy stripped (magic-byte sniff)', async () => {
    const tts = new UsejarvisTTS('https://llm.usejarvis.host', 'sk-uj-not-real');
    globalThis.fetch = mock(async () => new Response(mp3Bytes, { headers: { 'Content-Type': 'application/octet-stream' } })) as any;
    expect(Buffer.compare(await tts.synthesize('hi'), Buffer.from(mp3Bytes))).toBe(0);
  });

  test('factory passes a non-Edge cfg voice through; Edge neural names fall back to alloy', async () => {
    const voices: string[] = [];
    globalThis.fetch = mock(async (_url: string, init: any) => {
      voices.push(JSON.parse(init.body as string).voice);
      return new Response(mp3Bytes);
    }) as any;

    const hosted = { baseUrl: 'https://llm.usejarvis.host', apiKey: 'sk-uj-not-real' };
    await createTTSProvider({ enabled: true, provider: 'usejarvis', voice: 'nova' }, hosted)!.synthesize('hi');
    // The persisted default 'en-US-AriaNeural' is Edge-specific — the
    // OpenAI-compatible proxy would reject it, so it must not leak through.
    await createTTSProvider({ enabled: true, provider: 'usejarvis', voice: 'en-US-AriaNeural' }, hosted)!.synthesize('hi');
    expect(voices).toEqual(['nova', 'alloy']);
  });
});

describe('magic-byte labeling of the shared STT upload buffer', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  // One provider instance serves the dashboard mic (WAV), Telegram voice
  // notes (OGG/Opus) and Discord attachments — the declared part must track
  // the buffer, not a hardcoded container.
  for (const [label, make] of [
    ['OpenAIWhisperSTT', () => new OpenAIWhisperSTT('test-key-not-real')],
    ['GroqWhisperSTT', () => new GroqWhisperSTT('test-key-not-real')],
    ['UsejarvisSTT', () => new UsejarvisSTT('https://llm.usejarvis.host', 'sk-uj-not-real')],
  ] as const) {
    test(`${label} labels a WAV buffer audio.wav and an OGG buffer audio.ogg`, async () => {
      const files: File[] = [];
      globalThis.fetch = mock(async (_url: string, init: any) => {
        files.push((init.body as FormData).get('file') as File);
        return new Response(JSON.stringify({ text: 'ok' }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as any;

      const provider = make();
      await provider.transcribe(makeWavBuffer());
      await provider.transcribe(makeOggBuffer());
      expect(files.map((f) => [f.name, f.type])).toEqual([
        ['audio.wav', 'audio/wav'],
        ['audio.ogg', 'audio/ogg'],
      ]);
    });
  }
});

describe('SarvamSTT.transcribe', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('passes configured language_code through to Sarvam request', async () => {
    const stt = new SarvamSTT('sk_test_not_real', 'saaras:v3', 'hi-IN');
    const wav = makeWavBuffer();
    let sentLanguage = '';

    globalThis.fetch = mock(async (_url: string, init: any) => {
      const body = init.body as FormData;
      sentLanguage = String(body.get('language_code'));
      return new Response(JSON.stringify({ transcript: 'namaste' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    expect(await stt.transcribe(wav)).toBe('namaste');
    expect(sentLanguage).toBe('hi-IN');
  });

  test('defaults language_code to "unknown" (auto-detect) when not configured', async () => {
    const stt = new SarvamSTT('sk_test_not_real');
    const wav = makeWavBuffer();
    let sentLanguage = '';

    globalThis.fetch = mock(async (_url: string, init: any) => {
      const body = init.body as FormData;
      sentLanguage = String(body.get('language_code'));
      return new Response(JSON.stringify({ transcript: 'hi' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;

    await stt.transcribe(wav);
    expect(sentLanguage).toBe('unknown');
  });

  test('throws when response body has neither transcript nor text', async () => {
    const stt = new SarvamSTT('sk_test_not_real');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), {
        headers: { 'content-type': 'application/json' },
      })
    ) as any;

    await expect(stt.transcribe(wav)).rejects.toThrow('Sarvam STT returned no transcript');
  });

  test('throws on HTTP error with status', async () => {
    const stt = new SarvamSTT('sk_test_not_real');
    const wav = makeWavBuffer();

    globalThis.fetch = mock(async () =>
      new Response('unauthorized', { status: 401 })
    ) as any;

    await expect(stt.transcribe(wav)).rejects.toThrow(/Sarvam STT error \(401\)/);
  });
});

describe('hosted STT error redaction', () => {
  // This block stubs globalThis.fetch and MUST restore it: the file-level
  // afterEach lives in another describe, and a leaked stub fails unrelated
  // test files (websocket's health endpoint suddenly returns our 401 body).
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('never lets key-shaped material out of either STT throw', async () => {
    const leak = 'sk-uj-LIFETIMEKEY0000000000';
    // error branch
    globalThis.fetch = (async () =>
      new Response(`Authentication Error: bearer ${leak} rejected`, { status: 401 })) as unknown as typeof fetch;
    const stt = new UsejarvisSTT('https://llm.usejarvis.host', 'sk-uj-abc');
    await expect(stt.transcribe(makeWavBuffer())).rejects.toThrow(/\(401\)/);
    await stt.transcribe(makeWavBuffer()).catch((e: Error) => {
      expect(e.message).not.toContain(leak);
    });
    // 200-with-no-transcript branch (a proxy/CDN interstitial)
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ note: `upstream said ${leak}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    await stt.transcribe(makeWavBuffer()).catch((e: Error) => {
      expect(e.message).not.toContain(leak);
      expect(e.message).toContain('***redacted***');
    });
  });
});

describe('UsejarvisSTT non-JSON 200', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  // response.json() rejects with "Failed to parse JSON" — no provider, no
  // status, no body — so a CDN interstitial served with a 200 used to leave
  // nothing to correlate. Still redacted and capped.
  test('reports the provider and a redacted body instead of a bare parse error', async () => {
    const key = 'sk-uj-LIFETIMEKEY0000000000';
    globalThis.fetch = mock(async () => new Response(
      `<html><body>Access denied. token=${key}</body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )) as any;
    const stt = new UsejarvisSTT('https://llm.usejarvis.host', key);
    const err = await stt.transcribe(makeWavBuffer()).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('non-JSON body');
    expect(err!.message).toContain('Usejarvis AI STT');
    expect(err!.message).not.toContain(key);
  });
});

describe('STT language is configurable (was hardcoded to en everywhere)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const languageSentBy = async (config: STTConfig, hosted?: { baseUrl: string; apiKey: string }): Promise<string | null> => {
    let sent: string | null = null;
    globalThis.fetch = mock(async (_url: string, init: any) => {
      const value = (init.body as FormData).get('language');
      sent = value === null ? null : String(value);
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as any;
    await createSTTProvider(config, hosted)!.transcribe(makeWavBuffer());
    return sent;
  };

  test('unset language omits the param entirely — Whisper auto-detects', async () => {
    const hosted = { baseUrl: 'https://llm.usejarvis.host', apiKey: 'sk-uj-not-real' };
    // Forcing 'en' made an Italian hosted user's speech decode (or translate)
    // as English; absence is the documented auto-detect switch.
    expect(await languageSentBy({ provider: 'openai', openai: { api_key: 'k' } })).toBeNull();
    expect(await languageSentBy({ provider: 'groq', groq: { api_key: 'k' } })).toBeNull();
    expect(await languageSentBy({ provider: 'usejarvis' }, hosted)).toBeNull();
  });

  test('a configured language reaches every Whisper-shaped provider', async () => {
    const hosted = { baseUrl: 'https://llm.usejarvis.host', apiKey: 'sk-uj-not-real' };
    expect(await languageSentBy({ provider: 'openai', language: 'it', openai: { api_key: 'k' } })).toBe('it');
    expect(await languageSentBy({ provider: 'groq', language: 'it', groq: { api_key: 'k' } })).toBe('it');
    expect(await languageSentBy({ provider: 'usejarvis', language: 'it' }, hosted)).toBe('it');
  });
});
