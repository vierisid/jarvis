# Vault Extractor

The Vault Extractor is an LLM-powered knowledge extraction system that automatically extracts entities, facts, relationships, and commitments from conversations and stores them in the J.A.R.V.I.S. knowledge graph.

## Features

- **Automatic Extraction**: Extracts structured knowledge from unstructured conversations
- **Entity Recognition**: Identifies people, projects, tools, places, concepts, and events
- **Fact Extraction**: Captures attributes and properties of entities
- **Relationship Mapping**: Discovers connections between entities
- **Commitment Tracking**: Detects promises, tasks, and reminders
- **LLM-Powered**: Uses any LLM provider for intelligent extraction
- **Deduplication**: Reuses existing entities to maintain graph integrity
- **Provenance**: Every extracted claim is stored as inferred or reported evidence.
  Extraction can never confirm a fact or supersede a confirmed correction -- only
  an explicit decision in the Memory room can. See
  `docs/superpowers/specs/2026-09-14-memory-provenance-design.md`.

## Architecture

The Vault Extractor is a single module with three main functions:

### 1. Prompt Building (`buildExtractionPrompt`)

Constructs a specialized prompt for LLMs to extract structured data.

```typescript
import { buildExtractionPrompt } from '@/vault';

const prompt = buildExtractionPrompt(
  "My sister Anna's birthday is March 15",
  "I'll remember that!"
);
```

### 2. Response Parsing (`parseExtractionResponse`)

Parses LLM JSON responses into structured `ExtractionResult`.

```typescript
import { parseExtractionResponse } from '@/vault';

const result = parseExtractionResponse(llmResponse);
// Returns: { entities, facts, relationships, commitments }
```

### 3. Extract and Store (`extractAndStore`)

High-level function that orchestrates the entire extraction pipeline.

```typescript
import { extractAndStore } from '@/vault';

const result = await extractAndStore(
  userMessage,
  assistantResponse,
  llmProvider  // Optional: returns empty if not provided
);
```

## Data Structures

### ExtractionResult

```typescript
{
  entities: Array<{
    name: string;
    type: 'person' | 'project' | 'tool' | 'place' | 'concept' | 'event';
    properties?: Record<string, unknown>;
  }>;
  facts: Array<{
    subject: string;        // Entity name
    predicate: string;      // Property name (snake_case)
    object: string;         // Value
    confidence: number;     // 0.0-1.0
    user_quote?: string;    // Supporting quote, kept only if it really is in the user message
    scope?: string;         // Explicit context, e.g. work or personal
    valid_from?: number;    // Explicit validity start, epoch ms
    valid_to?: number;      // Explicit exclusive validity end, epoch ms
  }>;
  relationships: Array<{
    from: string;          // Entity name
    to: string;            // Entity name
    type: string;          // Relationship type (snake_case)
  }>;
  commitments: Array<{
    what: string;                    // Description
    when_due?: string;               // ISO date string
    priority?: 'low' | 'normal' | 'high' | 'critical';
  }>;
}
```

## Usage Examples

### Basic Extraction

```typescript
import { extractAndStore } from '@/vault';
import { AnthropicProvider } from '@/llm/anthropic';

// Initialize LLM provider
const llm = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);

// Extract knowledge from conversation
const result = await extractAndStore(
  "My colleague Bob works at Microsoft. His email is bob@microsoft.com",
  "Got it! I've saved Bob's information.",
  llm
);

console.log(`Extracted ${result.entities.length} entities`);
console.log(`Extracted ${result.facts.length} facts`);
```

### Query Extracted Knowledge

```typescript
import { findEntities, findFacts, findRelationships } from '@/vault';

// Find all person entities
const people = findEntities({ type: 'person' });

// Find facts about a specific person
const bob = findEntities({ name: 'Bob', type: 'person' })[0];
const bobFacts = findFacts({ subject_id: bob.id });

// Find relationships
const relationships = findRelationships({ from_id: bob.id });
```

### Manual Prompt Building (Advanced)

```typescript
import { buildExtractionPrompt } from '@/vault';

// Build custom prompt
const prompt = buildExtractionPrompt(userMsg, assistantMsg);

// Call your LLM
const response = await myLLM.chat([{ role: 'user', content: prompt }]);

// Parse response
const result = parseExtractionResponse(response.content);
```

## Extraction Guidelines

The extractor follows these principles:

### Entity Types

- **person**: Individuals (e.g., "Anna", "Bob", "Sarah")
- **project**: Projects or initiatives (e.g., "Project Phoenix", "Website Redesign")
- **tool**: Software, services, platforms (e.g., "GitHub", "Slack", "Python")
- **place**: Locations (e.g., "New York", "Office", "Home")
- **concept**: Abstract ideas (e.g., "Machine Learning", "Agile Development")
- **event**: Occurrences (e.g., "Birthday Party", "Team Meeting")

### Predicate Naming

Facts use snake_case predicates:
- `birthday_is`: "March 15"
- `email_is`: "bob@example.com"
- `works_at`: "Google"
- `role_is`: "software engineer"
- `location_is`: "San Francisco"

### Relationship Types

Relationships are typed connections:
- `manages`: Management relationship
- `works_at`: Employment
- `part_of`: Membership/containment
- `sister_of`, `brother_of`: Family relations
- `collaborates_with`: Collaboration

### Confidence Levels

- **1.0**: Explicitly stated facts
- **0.8-0.9**: Strongly implied facts
- **0.5-0.7**: Weakly implied or inferred facts
- **< 0.5**: Speculative information (use cautiously)

## Integration Pattern

### In Message Handler

```typescript
async function handleMessage(userMessage: string) {
  // 1. Generate assistant response
  const response = await llm.chat([
    { role: 'user', content: userMessage }
  ]);

  // 2. Extract knowledge from conversation
  await extractAndStore(userMessage, response.content, llm);

  // 3. Return response to user
  return response.content;
}
```

### With Background Processing

```typescript
import { createObservation } from '@/vault';

// Queue extraction for background processing
async function queueExtraction(userMsg: string, assistantMsg: string) {
  createObservation('conversation', {
    user_message: userMsg,
    assistant_message: assistantMsg,
  });
}

// Background worker
async function processExtractions(llm: LLMProvider) {
  const unprocessed = getUnprocessed();

  for (const obs of unprocessed) {
    const { user_message, assistant_message } = JSON.parse(obs.data);

    await extractAndStore(user_message, assistant_message, llm);

    markProcessed(obs.id);
  }
}
```

## Performance Considerations

### LLM Costs

Each extraction requires an LLM call:
- **Input tokens**: ~200-400 (prompt + conversation)
- **Output tokens**: ~100-300 (extracted JSON)
- **Cost**: ~$0.001-0.01 per extraction (varies by model)

**Optimization strategies:**
- Use smaller, faster models (e.g., Claude Haiku, GPT-3.5)
- Batch extractions in background workers
- Skip extraction for simple acknowledgments
- Cache recent extractions

### Database Performance

- Entity lookups use indexed name/type queries
- Facts are indexed by subject_id and predicate
- Relationships are indexed by from_id, to_id, and type
- Use transactions for bulk inserts

## Error Handling

The extractor is defensive and handles errors gracefully:

```typescript
// Invalid JSON → returns empty result
const result1 = parseExtractionResponse("Not JSON");
// result1 = { entities: [], facts: [], relationships: [], commitments: [] }

// Invalid entity type → skips entity, logs warning
// "invalid_type" is not in allowed types

// Missing entities → skips dependent records
// If "Bob" entity doesn't exist, facts about Bob are skipped

// No LLM provider → returns empty immediately
const result2 = await extractAndStore(msg1, msg2);  // No provider
// result2 = empty result, no LLM call made
```

## Testing

Run the test suite:

```bash
bun test src/vault/extractor.test.ts
```

Run the demo:

```bash
bun run examples/extractor-demo.ts
```

## Example Output

**Input:**
```
User: "My sister Anna's birthday is March 15th. She works at Google."
Assistant: "I'll remember that Anna's birthday is March 15th!"
```

**Extracted Knowledge:**
```json
{
  "entities": [
    { "name": "Anna", "type": "person" },
    { "name": "Google", "type": "tool" }
  ],
  "facts": [
    { "subject": "Anna", "predicate": "birthday_is", "object": "March 15", "confidence": 1.0 },
    { "subject": "Anna", "predicate": "works_at", "object": "Google", "confidence": 1.0 }
  ],
  "relationships": [
    { "from": "User", "to": "Anna", "type": "sister_of" },
    { "from": "Anna", "to": "Google", "type": "works_at" }
  ],
  "commitments": [
    { "what": "Remind about Anna's birthday", "when_due": "2026-03-14T09:00:00Z" }
  ]
}
```

## Best Practices

1. **Regular Extraction**: Extract from every substantive conversation
2. **Background Processing**: Queue extractions to avoid blocking user responses
3. **Model Selection**: Use fast, cheap models for extraction (Claude Haiku, GPT-3.5)
4. **Error Logging**: Monitor extraction failures for prompt improvements
5. **Deduplication**: The system automatically reuses existing entities
6. **Validation**: Verify extracted commitments before acting on them
7. **Privacy**: Never extract sensitive data (passwords, API keys, etc.)

## Limitations

- **Context Window**: Limited to single conversation turns (not full history)
- **LLM Accuracy**: Extraction quality depends on LLM capabilities
- **Ambiguity**: May misinterpret unclear references
- **Language Support**: Works best with English text
- **Cost**: Each extraction requires an LLM API call

## Future Enhancements

- [ ] Multi-turn context extraction
- [ ] Entity disambiguation (multiple "Bob"s)
- [ ] Automatic entity merging
- [ ] Extraction quality metrics
- [ ] Fine-tuned extraction models
- [ ] Streaming extraction for long conversations
- [ ] Multi-language support
