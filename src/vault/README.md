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
- **Input limits** (`input-limits.ts`): entity name 200 characters, relationship label 100, fact predicate 200, fact value 4000 (UTF-16 units, as an HTML `maxlength` counts). The character rule is the one task text uses (`commitment-text.ts`): no C0 or C1 control, DEL, line or paragraph separator or lone surrogate (a fact value may keep tab and line breaks), and the bidi controls and stray tag characters are dropped on save. Letters of every script, ZWJ, ZWNJ and variation selectors are kept. The API refuses a breach with a 400, including a corrected fact value. `createEntity`, `updateEntity` and `createRelationship` also serve the model, awareness and profile sync, so they never throw: controls become spaces and an over-long value is cut at the limit; the extractor looks a name up under its cleaned form so it is not added again. Rows stored before the limits keep their full text.

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
