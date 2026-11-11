# Vault Module

Knowledge graph storage and extraction system for J.A.R.V.I.S.

## Modules

- **`schema.ts`**: Database schema and initialization
- **`entities.ts`**: Entity CRUD operations
- **`facts.ts`**: Fact storage and queries
- **`relationships.ts`**: Relationship management
- **`commitments.ts`**: Promise and task tracking
- **`observations.ts`**: Raw event storage
- **`vectors.ts`**: Embedding storage for semantic search
- **`extractor.ts`**: LLM-powered knowledge extraction
- **`index.ts`**: Public API exports

## Quick Start

### Initialize Database

```typescript
import { initDatabase } from '@/vault';

initDatabase('./data/jarvis.db');
```

### Store Knowledge Manually

```typescript
import { createEntity, createFact, createRelationship } from '@/vault';

// Create entity
const anna = createEntity('person', 'Anna', {
  role: 'software engineer',
});

// Add fact
createFact(anna.id, 'birthday_is', 'March 15', {
  confidence: 1.0,
});

// Create relationship
const google = createEntity('tool', 'Google');
createRelationship(anna.id, google.id, 'works_at');
```

### Extract Knowledge with LLM

```typescript
import { extractAndStore } from '@/vault';
import { AnthropicProvider } from '@/llm/anthropic';

const llm = new AnthropicProvider(process.env.ANTHROPIC_API_KEY);

const result = await extractAndStore(
  "Anna's birthday is March 15th",
  "I'll remember that!",
  llm
);
```

### Query Knowledge

```typescript
import { findEntities, findFacts, findCommitments } from '@/vault';

// Find people
const people = findEntities({ type: 'person' });

// Find facts about Anna
const facts = findFacts({ subject_id: anna.id });

// Find pending commitments
const pending = findCommitments({ status: 'pending' });
```

## Documentation

- **Vault Extractor**: [docs/VAULT_EXTRACTOR.md](~/jarvis/docs/VAULT_EXTRACTOR.md)
- **Entity Types**: person, project, tool, place, concept, event
- **Commitment Statuses**: pending, active, completed, failed, escalated
- **Input limits** (`input-limits.ts`): entity name 200 characters, relationship label 100, fact predicate 200, fact value 4000. No control characters (C0 and DEL; a fact value may keep tab and line breaks). The API refuses a breach with a 400. `createEntity` and `createRelationship` also serve the model and awareness, so they never throw: control characters become spaces and an over-long value is cut at the limit. Rows stored before the limits keep their full text.

## Testing

```bash
# Test extractor
bun test src/vault/extractor.test.ts

# Test entire vault (if you have other tests)
bun test src/vault/**/*.test.ts
```

## Demo

```bash
bun run examples/extractor-demo.ts
```

## Database Schema

SQLite database with the following tables:
- `entities`: People, projects, tools, places, concepts, events
- `facts`: Atomic knowledge with confidence scores
- `relationships`: Typed edges between entities
- `commitments`: Promises and tasks
- `observations`: Raw events
- `vectors`: Embeddings for semantic search
- `agent_messages`: Inter-agent communication
- `personality_state`: Personality model storage
- `conversations`: Conversation tracking
