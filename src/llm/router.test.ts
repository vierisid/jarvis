import { test, expect, describe, beforeEach } from 'bun:test';
import { LLMRouter } from './router.ts';
import { LLMManager } from './manager.ts';
import type { JarvisConfig } from '../config/types.ts';

describe('LLMRouter', () => {
  let manager: LLMManager;
  let config: JarvisConfig;

  beforeEach(() => {
    manager = new LLMManager();
    // Register some mock providers
    manager.registerProvider({ name: 'openai', chat: async () => ({}) } as any);
    manager.registerProvider({ name: 'nvidia', chat: async () => ({}) } as any);
    manager.registerProvider({ name: 'ollama', chat: async () => ({}) } as any);
    
    config = {
      llm: {
        openai: { api_key: 'sk-test' },
        nvidia: { api_key: 'nv-test', model: 'usdcode' },
        ollama: { base_url: 'http://localhost' },
        primary: 'openai',
        fallback: ['nvidia', 'ollama']
      }
    } as any;
  });

  test('scans availability based on config', () => {
    const router = new LLMRouter(manager, config);
    expect(router.getAvailableNames()).toContain('openai');
    expect(router.getAvailableNames()).toContain('nvidia');
    expect(router.getAvailableNames()).toContain('ollama');
  });

  test('routes COMPLEX intent to premium/high-tier', () => {
    const router = new LLMRouter(manager, config);
    // Premium (openai) is available
    expect(router.getBestProvider('COMPLEX')).toBe('openai');
  });

  test('routes COMPLEX intent to FREE_FAST if PREMIUM missing', () => {
    config.llm.openai = undefined;
    const router = new LLMRouter(manager, config);
    // NVIDIA is available and mapped to FREE_FAST
    expect(router.getBestProvider('COMPLEX')).toBe('nvidia');
  });

  test('routes SIMPLE intent to ECO tier', () => {
    const router = new LLMRouter(manager, config);
    // Ollama is ECO
    expect(router.getBestProvider('SIMPLE')).toBe('ollama');
  });

  test('picks cheapest available correctly', () => {
    const router = new LLMRouter(manager, config);
    expect(router.getCheapestAvailable()).toBe('ollama');
  });
});
