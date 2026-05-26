import { test, expect, beforeEach, describe } from 'bun:test';
import { initDatabase } from './schema.ts';
import {
  buildExtractionPrompt,
  parseExtractionResponse,
  extractAndStore,
  type ExtractionResult,
} from './extractor.ts';
import { findEntities } from './entities.ts';
import { findFacts } from './facts.ts';
import { findRelationships } from './relationships.ts';
import { findCommitments } from './commitments.ts';
import type { LLMProvider, LLMMessage, LLMOptions, LLMResponse } from '../llm/provider.ts';
import { LLMManager } from '../llm/manager.ts';

/**
 * Wrap a mock LLMProvider in a real LLMManager wired to the `medium` tier,
 * matching how extractAndStore expects to be invoked.
 */
function makeManager(provider: LLMProvider): LLMManager {
  const m = new LLMManager();
  m.registerProvider(provider);
  m.setTierMap({ medium: { provider: provider.name } });
  return m;
}

describe('Vault Extractor', () => {
  beforeEach(() => {
    // Initialize in-memory database for each test
    initDatabase(':memory:');
  });

  describe('buildExtractionPrompt', () => {
    test('should build prompt with user and assistant messages', () => {
      const userMessage = "My sister Anna's birthday is March 15th";
      const assistantResponse = "I'll remember that Anna's birthday is March 15th!";

      const prompt = buildExtractionPrompt(userMessage, assistantResponse);

      expect(prompt).toContain('USER MESSAGE:');
      expect(prompt).toContain(userMessage);
      expect(prompt).toContain('ASSISTANT RESPONSE:');
      expect(prompt).toContain(assistantResponse);
      expect(prompt).toContain('entities');
      expect(prompt).toContain('facts');
      expect(prompt).toContain('relationships');
      expect(prompt).toContain('commitments');
    });
  });

  describe('parseExtractionResponse', () => {
    test('should parse valid JSON response', () => {
      const response = JSON.stringify({
        entities: [
          { name: 'Anna', type: 'person' },
        ],
        facts: [
          { subject: 'Anna', predicate: 'birthday_is', object: 'March 15', confidence: 1.0 },
        ],
        relationships: [],
        commitments: [],
      });

      const result = parseExtractionResponse(response);

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]!.name).toBe('Anna');
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.predicate).toBe('birthday_is');
    });

    test('should handle markdown code blocks', () => {
      const response = `\`\`\`json
{
  "entities": [{ "name": "Bob", "type": "person" }],
  "facts": [],
  "relationships": [],
  "commitments": []
}
\`\`\``;

      const result = parseExtractionResponse(response);

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]!.name).toBe('Bob');
    });

    test('should return empty result on invalid JSON', () => {
      const response = 'This is not JSON';

      const result = parseExtractionResponse(response);

      expect(result.entities).toHaveLength(0);
      expect(result.facts).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
      expect(result.commitments).toHaveLength(0);
    });

    test('should handle missing fields', () => {
      const response = JSON.stringify({
        entities: [{ name: 'Test', type: 'person' }],
        // Missing facts, relationships, commitments
      });

      const result = parseExtractionResponse(response);

      expect(result.entities).toHaveLength(1);
      expect(result.facts).toHaveLength(0);
      expect(result.relationships).toHaveLength(0);
      expect(result.commitments).toHaveLength(0);
    });
  });

  describe('extractAndStore', () => {
    test('should return empty result when no provider given', async () => {
      const result = await extractAndStore('Hello', 'Hi there');

      expect(result.entities).toHaveLength(0);
      expect(result.facts).toHaveLength(0);
    });

    test('should extract and store entities', async () => {
      const mockProvider: LLMProvider = {
        name: 'mock',
        async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
          return {
            content: JSON.stringify({
              entities: [
                { name: 'Alice', type: 'person' },
                { name: 'Project Phoenix', type: 'project' },
              ],
              facts: [],
              relationships: [],
              commitments: [],
            }),
            tool_calls: [],
            usage: { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            finish_reason: 'stop',
          };
        },
        async *stream() {
          yield { type: 'done', response: {} as any };
        },
        async listModels() {
          return ['mock-model'];
        },
      };

      const result = await extractAndStore(
        'Alice is working on Project Phoenix',
        'Got it!',
        makeManager(mockProvider),
      );

      expect(result.entities).toHaveLength(2);

      // Verify entities were stored in database
      const entities = findEntities({});
      expect(entities).toHaveLength(2);
      expect(entities.find((e) => e.name === 'Alice')).toBeDefined();
      expect(entities.find((e) => e.name === 'Project Phoenix')).toBeDefined();
    });

    test('should extract and store facts', async () => {
      const mockProvider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<LLMResponse> {
          return {
            content: JSON.stringify({
              entities: [
                { name: 'Bob', type: 'person' },
              ],
              facts: [
                { subject: 'Bob', predicate: 'email_is', object: 'bob@example.com', confidence: 1.0 },
              ],
              relationships: [],
              commitments: [],
            }),
            tool_calls: [],
            usage: { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            finish_reason: 'stop',
          };
        },
        async *stream() {
          yield { type: 'done', response: {} as any };
        },
        async listModels() {
          return ['mock-model'];
        },
      };

      await extractAndStore(
        "Bob's email is bob@example.com",
        'Noted!',
        makeManager(mockProvider),
      );

      // Verify fact was stored
      const facts = findFacts({});
      expect(facts).toHaveLength(1);
      expect(facts[0]!.predicate).toBe('email_is');
      expect(facts[0]!.object).toBe('bob@example.com');
    });

    test('should extract and store relationships', async () => {
      const mockProvider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<LLMResponse> {
          return {
            content: JSON.stringify({
              entities: [
                { name: 'Alice', type: 'person' },
                { name: 'Bob', type: 'person' },
              ],
              facts: [],
              relationships: [
                { from: 'Alice', to: 'Bob', type: 'manages' },
              ],
              commitments: [],
            }),
            tool_calls: [],
            usage: { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            finish_reason: 'stop',
          };
        },
        async *stream() {
          yield { type: 'done', response: {} as any };
        },
        async listModels() {
          return ['mock-model'];
        },
      };

      await extractAndStore(
        'Alice manages Bob',
        'Understood!',
        makeManager(mockProvider),
      );

      // Verify relationship was stored
      const relationships = findRelationships({});
      expect(relationships).toHaveLength(1);
      expect(relationships[0]!.type).toBe('manages');
    });

    test('should extract and store commitments', async () => {
      const mockProvider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<LLMResponse> {
          return {
            content: JSON.stringify({
              entities: [],
              facts: [],
              relationships: [],
              commitments: [
                {
                  what: 'Remind about meeting',
                  when_due: '2026-03-15T10:00:00Z',
                  priority: 'high',
                },
              ],
            }),
            tool_calls: [],
            usage: { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            finish_reason: 'stop',
          };
        },
        async *stream() {
          yield { type: 'done', response: {} as any };
        },
        async listModels() {
          return ['mock-model'];
        },
      };

      await extractAndStore(
        'Remind me about the meeting on March 15',
        'Will do!',
        makeManager(mockProvider),
      );

      // Verify commitment was stored
      const commitments = findCommitments({});
      expect(commitments).toHaveLength(1);
      expect(commitments[0]!.what).toBe('Remind about meeting');
      expect(commitments[0]!.priority).toBe('high');
      expect(commitments[0]!.when_due).toBeTruthy();
    });

    test('should reuse existing entities', async () => {
      const mockProvider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<LLMResponse> {
          return {
            content: JSON.stringify({
              entities: [
                { name: 'Charlie', type: 'person' },
              ],
              facts: [
                { subject: 'Charlie', predicate: 'location_is', object: 'NYC', confidence: 1.0 },
              ],
              relationships: [],
              commitments: [],
            }),
            tool_calls: [],
            usage: { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            finish_reason: 'stop',
          };
        },
        async *stream() {
          yield { type: 'done', response: {} as any };
        },
        async listModels() {
          return ['mock-model'];
        },
      };

      // First extraction
      await extractAndStore('Charlie lives in NYC', 'Got it!', makeManager(mockProvider));

      // Second extraction with same entity
      await extractAndStore('Charlie works remotely', 'Noted!', makeManager(mockProvider));

      // Should only have one Charlie entity
      const entities = findEntities({ name: 'Charlie' });
      expect(entities).toHaveLength(1);
    });

    test('should handle invalid entity types', async () => {
      const mockProvider: LLMProvider = {
        name: 'mock',
        async chat(): Promise<LLMResponse> {
          return {
            content: JSON.stringify({
              entities: [
                { name: 'Invalid', type: 'invalid_type' },
              ],
              facts: [],
              relationships: [],
              commitments: [],
            }),
            tool_calls: [],
            usage: { input_tokens: 100, output_tokens: 50 },
            model: 'mock-model',
            finish_reason: 'stop',
          };
        },
        async *stream() {
          yield { type: 'done', response: {} as any };
        },
        async listModels() {
          return ['mock-model'];
        },
      };

      await extractAndStore('Test', 'Test', makeManager(mockProvider));

      // Entity should not be created
      const entities = findEntities({});
      expect(entities).toHaveLength(0);
    });
  });
});
