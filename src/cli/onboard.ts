/**
 * J.A.R.V.I.S. Interactive Onboard Wizard
 *
 * Full first-time setup: user info, LLM provider, API keys, TTS, STT,
 * channels, personality, authority, autostart.
 * All steps are skippable except LLM configuration.
 */

import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import {
  c, printBanner, printStep, printOk, printWarn, printErr, printInfo,
  ask, askSecret, askYesNo, askChoice, startSpinner, closeRL, detectPlatform,
} from './helpers.ts';
import { DEFAULT_CONFIG, type JarvisConfig } from '../config/types.ts';
import { loadConfig, saveConfig } from '../config/loader.ts';
import { installAutostart, startAutostartService, getAutostartName, checkAutostartSupport } from './autostart.ts';
import { runDependencyCheck } from './deps.ts';
import { initDatabase, closeDb } from '../vault/schema.ts';
import { saveUserProfile } from '../vault/user-profile.ts';
import { USER_PROFILE_QUESTIONS, normalizeUserProfileAnswers } from '../user/profile.ts';

const JARVIS_DIR = join(homedir(), '.jarvis');
const CONFIG_PATH = join(JARVIS_DIR, 'config.yaml');
const TOTAL_STEPS = 11;

export async function runOnboard(): Promise<void> {
  printBanner();
  console.log(c.bold('Welcome to the J.A.R.V.I.S. setup wizard!\n'));
  console.log('This wizard will configure your personal AI assistant.');
  console.log(c.dim('Most steps can be skipped and configured later.\n'));

  // Load existing config or start with defaults
  let config: JarvisConfig;
  if (existsSync(CONFIG_PATH)) {
    console.log(c.dim(`Found existing config at ${CONFIG_PATH}`));
    const useExisting = await askYesNo('Use existing config as base?', true);
    config = useExisting ? await loadConfig() : structuredClone(DEFAULT_CONFIG);
  } else {
    config = structuredClone(DEFAULT_CONFIG);
  }

  // Ensure data directory
  if (!existsSync(JARVIS_DIR)) {
    mkdirSync(JARVIS_DIR, { recursive: true });
  }

  // ── Step 1: About You ──────────────────────────────────────────────

  printStep(1, TOTAL_STEPS, 'About You');
  console.log('  Let\'s get to know each other.\n');

  const userName = await ask('What\'s your name?', config.user?.name || '');
  config.user = { name: userName };

  const assistantName = await ask(
    'What would you like to call your assistant?',
    config.personality.assistant_name ?? 'Jarvis',
  );
  config.personality.assistant_name = assistantName;

  if (userName) {
    printOk(`Nice to meet you, ${userName}! I'll be your ${assistantName}.`);
  } else {
    printOk(`I'll be your ${assistantName}.`);
  }

  // ── Step 2: LLM Provider ──────────────────────────────────────────

  printStep(2, TOTAL_STEPS, 'LLM Provider');
  console.log('  JARVIS needs at least one AI model to function.\n');

  const provider = await askChoice('Choose your primary LLM provider:', [
    { label: 'Anthropic (Claude)', value: 'anthropic' as const, description: 'Best quality, recommended' },
    { label: 'OpenAI (GPT)', value: 'openai' as const, description: 'Good alternative' },
    { label: 'Google (Gemini)', value: 'gemini' as const, description: 'Google AI models' },
    { label: 'Ollama (Local)', value: 'ollama' as const, description: 'Free, runs locally' },
    { label: 'OpenRouter', value: 'openrouter' as const, description: 'Access hundreds of models via single API key' },
    { label: 'Groq', value: 'groq' as const, description: 'Fast, OpenAI-compatible API' },
  ], config.llm.primary as any);

  config.llm.primary = provider;

  // Get API key and model for cloud providers
  if (provider === 'anthropic') {
    const existing = config.llm.anthropic?.api_key;
    if (existing && existing.startsWith('sk-')) {
      const keep = await askYesNo(`API key found (${existing.slice(0, 10)}...). Keep it?`, true);
      if (!keep) {
        const key = await askSecret('Enter your Anthropic API key');
        if (key) config.llm.anthropic = { ...config.llm.anthropic, api_key: key };
      }
    } else {
      const configureNow = await askYesNo('Add your Anthropic API key now?', true);
      if (configureNow) {
        const key = await askSecret('Enter your Anthropic API key (from console.anthropic.com)');
        if (key) {
          config.llm.anthropic = { ...config.llm.anthropic, api_key: key };
        } else {
          printWarn('No API key set. JARVIS won\'t work without one.');
          printInfo('Set it later in ~/.jarvis/config.yaml');
        }
      } else {
        printWarn('No API key set. JARVIS won\'t work without one.');
        printInfo('Set it later in ~/.jarvis/config.yaml');
      }
    }

    const currentModel = config.llm.anthropic?.model ?? 'claude-sonnet-4-6';
    const anthropicModels = [
      { label: 'Claude Opus 4.6', value: 'claude-opus-4-6', description: 'Most capable, latest' },
      { label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6', description: 'Best balance of speed & quality' },
      { label: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5-20250929', description: 'Previous generation' },
      { label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001', description: 'Fastest, most affordable' },
      { label: 'Custom', value: 'custom', description: 'Enter model name manually' },
    ];
    const isPreset = anthropicModels.some(m => m.value === currentModel);
    const modelChoice = await askChoice('Choose a model:', anthropicModels, isPreset ? currentModel : 'custom');
    const model = modelChoice === 'custom' ? await ask('Enter model name', currentModel) : modelChoice;
    if (config.llm.anthropic) config.llm.anthropic.model = model;

  } else if (provider === 'openai') {
    const existing = config.llm.openai?.api_key;
    if (existing && existing.startsWith('sk-')) {
      const keep = await askYesNo(`API key found (${existing.slice(0, 10)}...). Keep it?`, true);
      if (!keep) {
        const key = await askSecret('Enter your OpenAI API key');
        if (key) config.llm.openai = { ...config.llm.openai, api_key: key };
      }
    } else {
      const configureNow = await askYesNo('Add your OpenAI API key now?', true);
      if (configureNow) {
        const key = await askSecret('Enter your OpenAI API key (from platform.openai.com)');
        if (key) {
          config.llm.openai = { ...config.llm.openai, api_key: key };
        } else {
          printWarn('No API key set. JARVIS won\'t work without one.');
        }
      } else {
        printWarn('No API key set. JARVIS won\'t work without one.');
      }
    }

    const currentModel = config.llm.openai?.model ?? 'gpt-5.4';
    const openaiModels = [
      { label: 'GPT-5.4', value: 'gpt-5.4', description: 'Latest flagship' },
      { label: 'GPT-5.4 Thinking', value: 'gpt-5.4-thinking', description: 'Flagship with reasoning' },
      { label: 'GPT-5.4 Pro', value: 'gpt-5.4-pro', description: 'Highest capability' },
      { label: 'GPT-5.3 Instant', value: 'gpt-5.3-instant', description: 'Fast flagship' },
      { label: 'GPT-5 Mini', value: 'gpt-5-mini', description: 'Cost-efficient' },
      { label: 'GPT-5 Nano', value: 'gpt-5-nano', description: 'Cheapest GPT-5' },
      { label: 'GPT-5.1 Codex', value: 'gpt-5.1-codex', description: 'Code-focused' },
      { label: 'GPT-4.1', value: 'gpt-4.1', description: 'Previous gen, still solid' },
      { label: 'o3', value: 'o3', description: 'Reasoning model' },
      { label: 'o4-mini', value: 'o4-mini', description: 'Fast reasoning' },
      { label: 'Custom', value: 'custom', description: 'Enter model name manually' },
    ];
    const isPreset = openaiModels.some(m => m.value === currentModel);
    const modelChoice = await askChoice('Choose a model:', openaiModels, isPreset ? currentModel : 'custom');
    const model = modelChoice === 'custom' ? await ask('Enter model name', currentModel) : modelChoice;
    if (config.llm.openai) config.llm.openai.model = model;

  } else if (provider === 'groq') {
    const existing = config.llm.groq?.api_key;
    if (existing && existing.length > 5) {
      const keep = await askYesNo(`API key found (${existing.slice(0, 10)}...). Keep it?`, true);
      if (!keep) {
        const key = await askSecret('Enter your Groq API key');
        if (key) config.llm.groq = { ...config.llm.groq, api_key: key };
      }
    } else {
      const configureNow = await askYesNo('Add your Groq API key now?', true);
      if (configureNow) {
        const key = await askSecret('Enter your Groq API key (from console.groq.com)');
        if (key) {
          config.llm.groq = { ...config.llm.groq, api_key: key };
        } else {
          printWarn('No API key set. JARVIS won\'t work without one.');
        }
      } else {
        printWarn('No API key set. JARVIS won\'t work without one.');
      }
    }

    const currentModel = config.llm.groq?.model ?? 'llama-3.3-70b-versatile';
    const groqModels = [
      { label: 'Llama 3.3 70B Versatile', value: 'llama-3.3-70b-versatile', description: 'Balanced capability and speed' },
      { label: 'Llama 3.1 8B Instant', value: 'llama-3.1-8b-instant', description: 'Fast and low latency' },
      { label: 'Qwen 3 32B', value: 'qwen/qwen3-32b', description: 'Strong general-purpose model' },
      { label: 'DeepSeek R1 Distill 70B', value: 'deepseek-r1-distill-llama-70b', description: 'Reasoning-focused model' },
      { label: 'Custom', value: 'custom', description: 'Enter model name manually' },
    ];
    const isPreset = groqModels.some(m => m.value === currentModel);
    const modelChoice = await askChoice('Choose a model:', groqModels, isPreset ? currentModel : 'custom');
    const model = modelChoice === 'custom' ? await ask('Enter model name', currentModel) : modelChoice;
    if (config.llm.groq) config.llm.groq.model = model;

  } else if (provider === 'gemini') {
    const existing = config.llm.gemini?.api_key;
    if (existing && existing.length > 5) {
      const keep = await askYesNo(`API key found (${existing.slice(0, 10)}...). Keep it?`, true);
      if (!keep) {
        const key = await askSecret('Enter your Google AI API key');
        if (key) config.llm.gemini = { ...config.llm.gemini, api_key: key };
      }
    } else {
      const configureNow = await askYesNo('Add your Google AI API key now?', true);
      if (configureNow) {
        const key = await askSecret('Enter your Google AI API key (from aistudio.google.com)');
        if (key) {
          config.llm.gemini = { ...config.llm.gemini, api_key: key };
        } else {
          printWarn('No API key set. JARVIS won\'t work without one.');
        }
      } else {
        printWarn('No API key set. JARVIS won\'t work without one.');
      }
    }

    const currentModel = config.llm.gemini?.model ?? 'gemini-3-flash-preview';
    const geminiModels = [
      { label: 'Gemini 3.1 Pro', value: 'gemini-3.1-pro-preview', description: 'Most intelligent, complex reasoning' },
      { label: 'Gemini 3 Deep Think', value: 'gemini-3-deep-think', description: 'Heavy science & research' },
      { label: 'Gemini 3 Flash', value: 'gemini-3-flash-preview', description: 'Fast, pro-level intelligence' },
      { label: 'Gemini 3.1 Flash-Lite', value: 'gemini-3-1-flash-lite-preview', description: 'Ultra-efficient, high-volume' },
      { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro', description: 'Previous gen, still solid' },
      { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash', description: 'Previous gen, fast' },
      { label: 'Custom', value: 'custom', description: 'Enter model name manually' },
    ];
    const isPreset = geminiModels.some(m => m.value === currentModel);
    const modelChoice = await askChoice('Choose a model:', geminiModels, isPreset ? currentModel : 'custom');
    const model = modelChoice === 'custom' ? await ask('Enter model name', currentModel) : modelChoice;
    if (config.llm.gemini) config.llm.gemini.model = model;

  } else if (provider === 'openrouter') {
    const existing = config.llm.openrouter?.api_key;
    if (existing && existing.startsWith('sk-or-')) {
      const keep = await askYesNo(`API key found (${existing.slice(0, 12)}...). Keep it?`, true);
      if (!keep) {
        const key = await askSecret('Enter your OpenRouter API key');
        if (key) config.llm.openrouter = { ...config.llm.openrouter, api_key: key };
      }
    } else {
      const configureNow = await askYesNo('Add your OpenRouter API key now?', true);
      if (configureNow) {
        const key = await askSecret('Enter your OpenRouter API key (from openrouter.ai/keys)');
        if (key) {
          config.llm.openrouter = { ...config.llm.openrouter, api_key: key };
        } else {
          printWarn('No API key set. JARVIS won\'t work without one.');
        }
      } else {
        printWarn('No API key set. JARVIS won\'t work without one.');
      }
    }

    const currentModel = config.llm.openrouter?.model ?? 'anthropic/claude-sonnet-4';
    const openrouterModels = [
      { label: 'Claude Sonnet 4', value: 'anthropic/claude-sonnet-4', description: 'Anthropic, great balance' },
      { label: 'Claude Opus 4', value: 'anthropic/claude-opus-4', description: 'Anthropic, most capable' },
      { label: 'Claude Haiku 4', value: 'anthropic/claude-haiku-4', description: 'Anthropic, fast & cheap' },
      { label: 'GPT-5.4', value: 'openai/gpt-5.4', description: 'OpenAI flagship' },
      { label: 'o3', value: 'openai/o3', description: 'OpenAI reasoning' },
      { label: 'Gemini 2.5 Pro', value: 'google/gemini-2.5-pro', description: 'Google, best quality' },
      { label: 'Gemini 2.5 Flash', value: 'google/gemini-2.5-flash', description: 'Google, fast' },
      { label: 'DeepSeek R1', value: 'deepseek/deepseek-r1', description: 'DeepSeek reasoning' },
      { label: 'Llama 4 Maverick', value: 'meta-llama/llama-4-maverick', description: 'Meta, open-weight' },
      { label: 'Mistral Large', value: 'mistralai/mistral-large', description: 'Mistral, strong all-round' },
      { label: 'Custom', value: 'custom', description: 'Enter model name manually' },
    ];
    const isPreset = openrouterModels.some(m => m.value === currentModel);
    const modelChoice = await askChoice('Choose a model:', openrouterModels, isPreset ? currentModel : 'custom');
    const model = modelChoice === 'custom' ? await ask('Enter model name (provider/model format)', currentModel) : modelChoice;
    if (config.llm.openrouter) config.llm.openrouter.model = model;

  } else if (provider === 'ollama') {
    const url = await ask('Ollama base URL', config.llm.ollama?.base_url ?? 'http://localhost:11434');

    const currentModel = config.llm.ollama?.model ?? 'llama3';
    const ollamaModels = [
      { label: 'Llama 3', value: 'llama3', description: 'General purpose' },
      { label: 'Llama 3 70B', value: 'llama3:70b', description: 'Larger, more capable' },
      { label: 'Mistral', value: 'mistral', description: 'Fast, good quality' },
      { label: 'DeepSeek Coder', value: 'deepseek-coder', description: 'Code-focused' },
      { label: 'CodeLlama', value: 'codellama', description: 'Code-focused' },
      { label: 'Custom', value: 'custom', description: 'Enter model name manually' },
    ];
    const isPreset = ollamaModels.some(m => m.value === currentModel);
    const modelChoice = await askChoice('Choose a model:', ollamaModels, isPreset ? currentModel : 'custom');
    const model = modelChoice === 'custom' ? await ask('Enter model name', currentModel) : modelChoice;

    config.llm.ollama = { base_url: url, model };
    printInfo('Make sure Ollama is running: ollama serve');
  }

  // Test connectivity
  const testConn = await askYesNo('Test LLM connectivity?', true);
  if (testConn) {
    const spin = startSpinner('Testing connection...');
    try {
      const { LLMManager, AnthropicProvider, OpenAIProvider, GroqProvider, GeminiProvider, OllamaProvider, OpenRouterProvider } = await import('../llm/index.ts');
      const manager = new LLMManager();

      if (provider === 'anthropic' && config.llm.anthropic?.api_key) {
        manager.registerProvider(new AnthropicProvider(config.llm.anthropic.api_key, config.llm.anthropic.model));
      } else if (provider === 'openai' && config.llm.openai?.api_key) {
        manager.registerProvider(new OpenAIProvider(config.llm.openai.api_key, config.llm.openai.model));
      } else if (provider === 'groq' && config.llm.groq?.api_key) {
        manager.registerProvider(new GroqProvider(config.llm.groq.api_key, config.llm.groq.model));
      } else if (provider === 'gemini' && config.llm.gemini?.api_key) {
        manager.registerProvider(new GeminiProvider(config.llm.gemini.api_key, config.llm.gemini.model));
      } else if (provider === 'openrouter' && config.llm.openrouter?.api_key) {
        manager.registerProvider(new OpenRouterProvider(config.llm.openrouter.api_key, config.llm.openrouter.model));
      } else if (provider === 'ollama') {
        manager.registerProvider(new OllamaProvider(config.llm.ollama?.base_url, config.llm.ollama?.model));
      }

      manager.setPrimary(provider);
      const resp = await Promise.race([
        manager.chat(
          [{ role: 'user', content: 'Say "JARVIS online" in 3 words.' }],
          { max_tokens: 20 },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timed out (15s)')), 15_000),
        ),
      ]);
      spin.stop(`Connected! Model: ${resp.model}`);
    } catch (err) {
      spin.stop();
      printErr(`Connection failed: ${err}`);
      printInfo('Check your API key and try again later.');
    }
  }

  // Fallback providers
  config.llm.fallback = ['anthropic', 'openai', 'gemini', 'ollama', 'openrouter', 'groq'].filter(p => p !== provider);

  // ── Step 3: Fallback API Keys ─────────────────────────────────────

  printStep(3, TOTAL_STEPS, 'Fallback Providers');
  console.log('  Optional: configure backup LLM providers.\n');

  const setupFallbacks = await askYesNo('Configure fallback providers?', false);
  if (setupFallbacks) {
    for (const fb of config.llm.fallback) {
      if (fb === 'anthropic' && (!config.llm.anthropic?.api_key || config.llm.anthropic.api_key === '')) {
        const configureProvider = await askYesNo('Configure Anthropic as a fallback provider?', false);
        if (configureProvider) {
          const key = await askSecret('Anthropic API key (for fallback)');
          if (key) config.llm.anthropic = { ...config.llm.anthropic, api_key: key, model: config.llm.anthropic?.model ?? 'claude-sonnet-4-6' };
        }
      } else if (fb === 'openai' && (!config.llm.openai?.api_key || config.llm.openai.api_key === '')) {
        const configureProvider = await askYesNo('Configure OpenAI as a fallback provider?', false);
        if (configureProvider) {
          const key = await askSecret('OpenAI API key (for fallback)');
          if (key) config.llm.openai = { ...config.llm.openai, api_key: key, model: config.llm.openai?.model ?? 'gpt-5.4' };
        }
      } else if (fb === 'groq' && (!config.llm.groq?.api_key || config.llm.groq.api_key === '')) {
        const configureProvider = await askYesNo('Configure Groq as a fallback provider?', false);
        if (configureProvider) {
          const key = await askSecret('Groq API key (for fallback)');
          if (key) config.llm.groq = { ...config.llm.groq, api_key: key, model: config.llm.groq?.model ?? 'llama-3.3-70b-versatile' };
        }
      } else if (fb === 'gemini' && (!config.llm.gemini?.api_key || config.llm.gemini.api_key === '')) {
        const configureProvider = await askYesNo('Configure Gemini as a fallback provider?', false);
        if (configureProvider) {
          const key = await askSecret('Google AI API key (for fallback)');
          if (key) config.llm.gemini = { ...config.llm.gemini, api_key: key, model: config.llm.gemini?.model ?? 'gemini-3-flash-preview' };
        }
      } else if (fb === 'openrouter' && (!config.llm.openrouter?.api_key || config.llm.openrouter.api_key === '')) {
        const configureProvider = await askYesNo('Configure OpenRouter as a fallback provider?', false);
        if (configureProvider) {
          const key = await askSecret('OpenRouter API key (for fallback)');
          if (key) config.llm.openrouter = { ...config.llm.openrouter, api_key: key, model: config.llm.openrouter?.model ?? 'anthropic/claude-sonnet-4' };
        }
      } else if (fb === 'ollama') {
        const setupOllama = await askYesNo('Configure Ollama as fallback?', false);
        if (setupOllama) {
          const url = await ask('Ollama URL', 'http://localhost:11434');
          const model = await ask('Ollama model', 'llama3');
          config.llm.ollama = { base_url: url, model };
        }
      }
    }
  } else {
    printInfo('Skipped. You can add fallback providers later in config.');
  }

  // ── Step 4: System Dependencies ─────────────────────────────────

  printStep(4, TOTAL_STEPS, 'System Dependencies');
  console.log('  Checking for optional system tools JARVIS can use.\n');

  await runDependencyCheck(config);

  // ── Step 5: TTS (Text-to-Speech) ─────────────────────────────────

  printStep(5, TOTAL_STEPS, 'Voice Output (TTS)');
  console.log('  JARVIS can speak responses aloud.\n');

  const enableTTS = await askYesNo('Enable text-to-speech?', false);
  config.tts = config.tts || { enabled: false };
  config.tts.enabled = enableTTS;

  if (enableTTS) {
    const ttsProvider = await askChoice('TTS provider:', [
      { label: 'Microsoft Edge TTS', value: 'edge' as const, description: 'Free, no API key needed' },
      { label: 'ElevenLabs', value: 'elevenlabs' as const, description: 'Premium quality, API key required' },
    ], config.tts.provider ?? 'edge');

    config.tts.provider = ttsProvider;

    if (ttsProvider === 'edge') {
      const voice = await askChoice('Choose a voice:', [
        { label: 'Aria (US Female)', value: 'en-US-AriaNeural' },
        { label: 'Guy (US Male)', value: 'en-US-GuyNeural' },
        { label: 'Sonia (UK Female)', value: 'en-GB-SoniaNeural' },
        { label: 'Natasha (AU Female)', value: 'en-AU-NatashaNeural' },
        { label: 'Jenny (US Female)', value: 'en-US-JennyNeural' },
        { label: 'Davis (US Male)', value: 'en-US-DavisNeural' },
      ], config.tts.voice ?? 'en-US-AriaNeural');
      config.tts.voice = voice;
    } else if (ttsProvider === 'elevenlabs') {
      const existing = config.tts.elevenlabs?.api_key;
      let apiKey: string;

      if (existing) {
        const keep = await askYesNo('ElevenLabs API key found. Keep it?', true);
        apiKey = keep ? existing : await askSecret('ElevenLabs API key (from elevenlabs.io)');
      } else {
        apiKey = await askSecret('ElevenLabs API key (from elevenlabs.io)');
      }

      if (apiKey) {
        config.tts.elevenlabs = {
          ...config.tts.elevenlabs,
          api_key: apiKey,
        };

        // Fetch available voices
        const spin = startSpinner('Fetching available voices...');
        try {
          const { listElevenLabsVoices } = await import('../comms/voice.ts');
          const voices = await Promise.race([
            listElevenLabsVoices(apiKey),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Timed out')), 10_000),
            ),
          ]);

          spin.stop(`Found ${voices.length} voices`);

          if (voices.length > 0) {
            const voiceOptions = voices.slice(0, 10).map(v => ({
              label: `${v.name} (${v.category})`,
              value: v.voice_id,
            }));
            voiceOptions.push({ label: 'Custom', value: 'custom' });

            const currentVoiceId = config.tts.elevenlabs.voice_id;
            const isPreset = voiceOptions.some(v => v.value === currentVoiceId);
            const voiceChoice = await askChoice(
              'Choose a voice:',
              voiceOptions,
              isPreset ? currentVoiceId : voiceOptions[0]!.value,
            );

            if (voiceChoice === 'custom') {
              const customId = await ask('Enter voice ID', currentVoiceId ?? '');
              config.tts.elevenlabs.voice_id = customId || undefined;
            } else {
              config.tts.elevenlabs.voice_id = voiceChoice;
            }
          }
        } catch {
          spin.stop();
          printWarn('Could not fetch voices. Using default voice.');
          const customId = await ask('Enter voice ID (optional)', config.tts.elevenlabs.voice_id ?? '');
          if (customId) config.tts.elevenlabs.voice_id = customId;
        }

        // Model selection
        const elModel = await askChoice('ElevenLabs model:', [
          { label: 'Flash v2.5', value: 'eleven_flash_v2_5', description: 'Fast, low latency' },
          { label: 'Multilingual v2', value: 'eleven_multilingual_v2', description: 'Higher quality' },
        ], config.tts.elevenlabs.model ?? 'eleven_flash_v2_5');
        config.tts.elevenlabs.model = elModel;
      } else {
        printWarn('No API key provided. Falling back to Edge TTS.');
        config.tts.provider = 'edge';
        config.tts.voice = 'en-US-AriaNeural';
      }
    }
  } else {
    printInfo('Skipped. Enable later in config.');
  }

  // ── Step 6: STT (Speech-to-Text) ─────────────────────────────────

  printStep(6, TOTAL_STEPS, 'Voice Input (STT)');
  console.log('  For voice commands via the dashboard microphone button.\n');

  const setupSTT = await askYesNo('Configure speech-to-text?', false);
  if (setupSTT) {
    const sttProvider = await askChoice('STT provider:', [
      { label: 'OpenAI Whisper', value: 'openai' as const, description: 'Best accuracy, uses OpenAI API key' },
      { label: 'Groq Whisper', value: 'groq' as const, description: 'Fast, free tier available' },
      { label: 'Local Whisper', value: 'local' as const, description: 'Self-hosted, fully private' },
    ], config.stt?.provider as any ?? 'openai');

    config.stt = { provider: sttProvider };

    if (sttProvider === 'openai') {
      // Reuse OpenAI API key if already set
      if (config.llm.openai?.api_key) {
        const reuse = await askYesNo('Reuse your OpenAI API key for STT?', true);
        if (reuse) {
          config.stt.openai = { api_key: config.llm.openai.api_key };
        } else {
          const key = await askSecret('OpenAI API key for STT');
          if (key) config.stt.openai = { api_key: key };
        }
      } else {
        const key = await askSecret('OpenAI API key for Whisper STT');
        if (key) config.stt.openai = { api_key: key };
      }
    } else if (sttProvider === 'groq') {
      const key = await askSecret('Groq API key (from console.groq.com)');
      if (key) config.stt.groq = { api_key: key };
    } else if (sttProvider === 'local') {
      const endpoint = await ask('Local Whisper endpoint', 'http://localhost:8080');
      config.stt.local = { endpoint };
    }
  } else {
    printInfo('Skipped. Voice input will be disabled.');
  }

  // ── Step 7: Channels ──────────────────────────────────────────────

  printStep(7, TOTAL_STEPS, 'Communication Channels');
  console.log('  JARVIS can receive messages from Telegram and Discord.\n');

  const setupChannels = await askYesNo('Configure messaging channels?', false);
  if (setupChannels) {
    // Telegram
    const setupTG = await askYesNo('Set up Telegram?', false);
    if (setupTG) {
      const token = await askSecret('Telegram bot token (from @BotFather)');
      if (token) {
        const userId = await ask('Your Telegram user ID (numeric)');
        config.channels = config.channels ?? {};
        config.channels.telegram = {
          enabled: true,
          bot_token: token,
          allowed_users: userId ? [parseInt(userId, 10)] : [],
        };
        printOk('Telegram configured.');
      }
    }

    // Discord
    const setupDC = await askYesNo('Set up Discord?', false);
    if (setupDC) {
      const token = await askSecret('Discord bot token (from discord.dev)');
      if (token) {
        const userId = await ask('Your Discord user ID');
        config.channels = config.channels ?? {};
        config.channels.discord = {
          enabled: true,
          bot_token: token,
          allowed_users: userId ? [userId] : [],
        };
        printOk('Discord configured.');
      }
    }
  } else {
    printInfo('Skipped. Configure channels later for remote access.');
  }

  // ── Step 8: Personality ───────────────────────────────────────────

  printStep(8, TOTAL_STEPS, 'Personality');
  console.log('  Customize JARVIS\'s personality traits.\n');

  const customPersonality = await askYesNo('Customize personality traits?', false);
  if (customPersonality) {
    console.log(c.dim('  Current traits: ' + config.personality.core_traits.join(', ')));
    const traitsInput = await ask(
      'Enter traits (comma-separated)',
      config.personality.core_traits.join(', ')
    );
    config.personality.core_traits = traitsInput.split(',').map(t => t.trim()).filter(Boolean);
    printOk(`Traits: ${config.personality.core_traits.join(', ')}`);
  } else {
    printInfo(`Using defaults: ${config.personality.core_traits.join(', ')}`);
  }

  // ── Step 9: Authority Level ───────────────────────────────────────

  printStep(9, TOTAL_STEPS, 'Authority & Safety');
  console.log('  Controls what JARVIS can do autonomously.\n');
  console.log(c.dim('  Level 1-3: Conservative (read-only, ask for everything)'));
  console.log(c.dim('  Level 4-6: Moderate (browse, read/write files, run safe commands)'));
  console.log(c.dim('  Level 7-10: Aggressive (full autonomy, sends emails, manages apps)'));
  console.log('');

  const customAuth = await askYesNo('Customize authority settings?', false);
  if (customAuth) {
    const levelStr = await ask('Default authority level (1-10)', String(config.authority.default_level));
    const level = parseInt(levelStr, 10);
    if (level >= 1 && level <= 10) {
      config.authority.default_level = level;
    }

    // Governed categories
    console.log(c.dim('\n  Governed categories require your approval before executing:'));
    console.log(c.dim('  Current: ' + config.authority.governed_categories.join(', ')));
    printInfo('Keeping default governed categories (send_email, send_message, make_payment)');
  } else {
    printInfo(`Using defaults: level ${config.authority.default_level}, governed: ${config.authority.governed_categories.join(', ')}`);
  }

  // ── Step 10: Keepalive ────────────────────────────────────────────

  printStep(10, TOTAL_STEPS, 'Keepalive');
  const platform = detectPlatform();
  let enableKeepalive = false;
  const support = checkAutostartSupport();

  if (!support.supported) {
    if (platform === 'wsl') {
      printInfo('WSL2 detected, but the user systemd service manager is not available in this session.');
      printInfo('Enable systemd in WSL, then rerun onboard to use 24/7 keepalive mode.');
    } else {
      printInfo('Keepalive mode is not supported in this environment.');
    }
    if (support.reason) {
      console.log(c.dim(`  (${support.reason})`));
    }
    printInfo('Start JARVIS manually with: jarvis start');
  } else {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const platformHint = platform === 'wsl' ? ' on WSL2' : '';
      console.log(`  Keepalive mode uses ${c.bold(getAutostartName())}${platformHint} to keep JARVIS running`);
      console.log('  after you close the terminal, with automatic restart if the service exits.\n');
      enableKeepalive = await askYesNo('Activate JARVIS keepalive mode?', false);
    } else {
      console.log(`  Autostart mechanism: ${c.bold(getAutostartName())}\n`);
      enableKeepalive = await askYesNo('Start JARVIS automatically?', false);
    }
  }

  // ── Step 11: Know Your User ───────────────────────────────────────

  printStep(11, TOTAL_STEPS, 'Know Your User');
  console.log('  Optional: answer a richer profile wizard so JARVIS starts with context about who you are,\n' +
    '  what you care about, and how you like to work.\n');

  let userProfileAnswers: Record<string, string> | null = null;
  const runProfileWizard = await askYesNo('Answer user profile questions now?', false);
  if (runProfileWizard) {
    const rawAnswers: Record<string, string> = {};

    for (const question of USER_PROFILE_QUESTIONS) {
      console.log('');
      console.log(c.bold(`  ${question.step_title} · ${question.label}`));
      console.log(c.dim(`  ${question.description}`));

      const defaultAnswer =
        question.id === 'preferred_name'
          ? (config.user?.name || '')
          : '';

      const answer = await ask(question.prompt, defaultAnswer);
      if (answer.trim()) {
        rawAnswers[question.id] = answer.trim();
      }
    }

    userProfileAnswers = normalizeUserProfileAnswers(rawAnswers) as Record<string, string>;
    printOk(`Captured ${Object.keys(userProfileAnswers).length} profile answer(s).`);
  } else {
    printInfo('Skipped. You can complete the same wizard later in Settings > Profile.');
  }

  // ── Port (quick inline question) ──────────────────────────────────

  console.log('');
  const changePort = await askYesNo(`Dashboard will run on port ${config.daemon.port}. Change it?`, false);
  if (changePort) {
    const portStr = await ask('Dashboard port', String(config.daemon.port));
    const port = parseInt(portStr, 10);
    if (port > 0 && port < 65536) config.daemon.port = port;
  }

  // ── Save ──────────────────────────────────────────────────────────

  console.log('\n' + c.bold('─'.repeat(50)));
  console.log(c.bold('\nConfiguration Summary:\n'));

  const ttsLabel = !config.tts?.enabled ? 'disabled'
    : config.tts.provider === 'elevenlabs' ? 'ElevenLabs'
    : `${config.tts.voice} (Edge)`;

  const summaryItems: [string, string][] = [
    ['User', config.user?.name || c.dim('not set')],
    ['Assistant', config.personality.assistant_name ?? 'Jarvis'],
    ['LLM Provider', `${config.llm.primary} (${config.llm[config.llm.primary as keyof typeof config.llm] ? 'configured' : 'not set'})`],
    ['Fallback', config.llm.fallback.join(' -> ')],
    ['TTS', ttsLabel],
    ['STT', config.stt?.provider ?? 'not configured'],
    ['Telegram', config.channels?.telegram?.enabled ? 'enabled' : 'disabled'],
    ['Discord', config.channels?.discord?.enabled ? 'enabled' : 'disabled'],
    ['Authority', `level ${config.authority.default_level}`],
    ['Keepalive', enableKeepalive ? 'enabled' : 'disabled'],
    ['Port', String(config.daemon.port)],
  ];

  for (const [key, value] of summaryItems) {
    console.log(`  ${c.dim(key.padEnd(16))} ${value}`);
  }

  console.log('');

  const doSave = await askYesNo('Save this configuration?', true);
  let keepaliveStarted = false;
  if (doSave) {
    await saveConfig(config);
    printOk(`Config saved to ${CONFIG_PATH}`);

    if (enableKeepalive) {
      const installed = await installAutostart();
      if (installed) {
        keepaliveStarted = await startAutostartService();
      }
    }

    if (userProfileAnswers && Object.keys(userProfileAnswers).length > 0) {
      try {
        initDatabase(resolveOnboardDbPath(config));
        saveUserProfile(userProfileAnswers);
        printOk('User profile saved to the vault.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        printWarn(`Config was saved, but user profile could not be stored: ${msg}`);
      } finally {
        closeDb();
      }
    }
  } else {
    printWarn('Configuration not saved.');
  }

  // Offer to start daemon
  console.log('');
  const keepaliveActive = doSave && keepaliveStarted;
  const defaultStartNow = keepaliveActive ? false : true;
  const startNowPrompt = keepaliveActive
    ? 'Start another foreground JARVIS process now?'
    : 'Start JARVIS now?';
  const startNow = await askYesNo(startNowPrompt, defaultStartNow);
  if (startNow) {
    console.log(c.cyan('\nStarting J.A.R.V.I.S. daemon...\n'));
    closeRL();

    const { startDaemon } = await import('../daemon/index.ts');
    await startDaemon();
  } else {
    if (keepaliveActive) {
      console.log(c.dim('\nJARVIS keepalive mode is managing the daemon.\n'));
    } else {
      console.log(c.dim('\nStart later with: jarvis start\n'));
    }
    closeRL();
  }
}

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return join(homedir(), filepath.slice(2));
  }
  return filepath;
}

function resolveOnboardDbPath(config: JarvisConfig): string {
  const dataDir = expandHome(config.daemon.data_dir);
  const dbPath = expandHome(config.daemon.db_path);
  return isAbsolute(dbPath) ? dbPath : join(dataDir, dbPath);
}
