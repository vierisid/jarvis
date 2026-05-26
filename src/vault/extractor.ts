import type { LLMManager } from '../llm/manager.ts';
import { createEntity, findEntities } from './entities.ts';
import { createFact } from './facts.ts';
import { createRelationship } from './relationships.ts';
import { createCommitment } from './commitments.ts';

export type ExtractionResult = {
  entities: Array<{ name: string; type: string; properties?: Record<string, unknown> }>;
  facts: Array<{ subject: string; predicate: string; object: string; confidence: number }>;
  relationships: Array<{ from: string; to: string; type: string }>;
  commitments: Array<{ what: string; when_due?: string; priority?: string }>;
};

/**
 * Build extraction prompt for LLM
 */
export function buildExtractionPrompt(userMessage: string, assistantResponse: string): string {
  return `You are an expert at extracting structured information from conversations. Analyze the following conversation and extract entities, facts, relationships, and commitments.

USER MESSAGE:
${userMessage}

ASSISTANT RESPONSE:
${assistantResponse}

Extract the following information and return ONLY valid JSON (no markdown, no explanation):

{
  "entities": [
    {
      "name": "Entity name",
      "type": "person|project|tool|place|concept|event",
      "properties": {}
    }
  ],
  "facts": [
    {
      "subject": "Entity name",
      "predicate": "property_name",
      "object": "value",
      "confidence": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "from": "Entity A name",
      "to": "Entity B name",
      "type": "relationship_type"
    }
  ],
  "commitments": [
    {
      "what": "Description of commitment",
      "when_due": "ISO date string (optional)",
      "priority": "low|normal|high|critical (optional)"
    }
  ]
}

GUIDELINES:
- Extract only concrete, verifiable information
- For entities: identify people, projects, tools, places, concepts, events
- For facts: extract attributes about entities (e.g., "birthday_is", "works_at", "location_is")
- For relationships: extract connections between entities (e.g., "sister_of", "manages", "part_of")
- For commitments: extract any promises, tasks, or reminders mentioned
- Use snake_case for predicates and relationship types
- Set confidence lower (0.5-0.8) for implied or uncertain information
- If no information to extract, return empty arrays
- Respond with ONLY the JSON object, no other text`;
}

/**
 * Parse LLM response into ExtractionResult
 */
export function parseExtractionResponse(llmResponse: string): ExtractionResult {
  // Clean up response - remove markdown code blocks if present
  let cleaned = llmResponse.trim();

  // Remove markdown JSON code blocks
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Validate and normalize the structure
    const result: ExtractionResult = {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
    };

    return result;
  } catch (_error) {

    // Return empty result on parse failure
    return {
      entities: [],
      facts: [],
      relationships: [],
      commitments: [],
    };
  }
}

/**
 * Parse ISO date string to timestamp, return null if invalid
 */
function parseDate(dateStr?: string): number | null {
  if (!dateStr) return null;

  try {
    const timestamp = new Date(dateStr).getTime();
    return isNaN(timestamp) ? null : timestamp;
  } catch {
    return null;
  }
}

/**
 * Validate entity type
 */
function isValidEntityType(type: string): type is 'person' | 'project' | 'tool' | 'place' | 'concept' | 'event' {
  return ['person', 'project', 'tool', 'place', 'concept', 'event'].includes(type);
}

/**
 * High-level: extract and store in vault
 */
export async function extractAndStore(
  userMessage: string,
  assistantResponse: string,
  llm?: LLMManager,
): Promise<ExtractionResult> {
  // If no manager, return empty result
  if (!llm) {
    return {
      entities: [],
      facts: [],
      relationships: [],
      commitments: [],
    };
  }

  try {
    // Build prompt
    const prompt = buildExtractionPrompt(userMessage, assistantResponse);

    // Run on the `low` tier - structured extraction with a small, focused
    // prompt is exactly what cheap/fast models are good at.
    const response = await llm.chatTier('low', 'vault_extractor', [
      { role: 'user', content: prompt },
    ], {
      temperature: 0.1, // Low temperature for consistent extraction
      max_tokens: 2000,
    });

    // Parse response
    const extraction = parseExtractionResponse(response.content);

    // Store entities
    const entityMap = new Map<string, string>(); // name -> id

    for (const entityData of extraction.entities) {
      const { name, type, properties } = entityData;

      // Validate type
      if (!isValidEntityType(type)) {
        console.warn(`Invalid entity type: ${type}, skipping entity ${name}`);
        continue;
      }

      // Check if entity already exists
      const existing = findEntities({ name, type });

      if (existing.length > 0) {
        // Use existing entity ID
        entityMap.set(name, existing[0]!.id);
      } else {
        // Create new entity
        const entity = createEntity(
          type,
          name,
          properties,
          'llm_extraction'
        );
        entityMap.set(name, entity.id);
      }
    }

    // Store facts
    for (const factData of extraction.facts) {
      const { subject, predicate, object, confidence } = factData;

      // Get subject entity ID
      const subjectId = entityMap.get(subject);
      if (!subjectId) {
        console.warn(`Subject entity not found: ${subject}, skipping fact`);
        continue;
      }

      createFact(subjectId, predicate, object, {
        confidence: confidence ?? 1.0,
        source: 'llm_extraction',
      });
    }

    // Store relationships
    for (const relData of extraction.relationships) {
      const { from, to, type } = relData;

      // Get entity IDs
      const fromId = entityMap.get(from);
      const toId = entityMap.get(to);

      if (!fromId || !toId) {
        console.warn(`Relationship entities not found: ${from} -> ${to}, skipping`);
        continue;
      }

      createRelationship(fromId, toId, type);
    }

    // Store commitments
    for (const commitmentData of extraction.commitments) {
      const { what, when_due, priority } = commitmentData;

      const whenDueTimestamp = parseDate(when_due);

      createCommitment(what, {
        when_due: whenDueTimestamp ?? undefined,
        priority: (priority as any) ?? 'normal',
        context: `Extracted from conversation`,
        created_from: 'llm_extraction',
      });
    }

    return extraction;
  } catch (error) {
    console.error('Failed to extract and store:', error);

    // Return empty result on error
    return {
      entities: [],
      facts: [],
      relationships: [],
      commitments: [],
    };
  }
}

/**
 * Extract a completed goal as a vault entity with performance facts.
 * Called when a goal is completed/failed/killed to build historical data
 * for future estimation.
 */
export function extractGoalCompletion(goal: {
  id: string;
  title: string;
  level: string;
  score: number;
  status: string;
  estimated_hours: number | null;
  actual_hours: number;
  created_at: number;
  completed_at: number | null;
  tags: string[];
}): void {
  try {
    // Create or find entity for this goal
    const existing = findEntities({ name: goal.title, type: 'concept' });
    let entityId: string;

    if (existing.length > 0) {
      entityId = existing[0]!.id;
    } else {
      const entity = createEntity('concept', goal.title, {
        goal_id: goal.id,
        goal_level: goal.level,
      }, 'goal_completion');
      entityId = entity.id;
    }

    // Store performance facts
    createFact(entityId, 'goal_final_score', goal.score.toFixed(2), {
      confidence: 1.0,
      source: 'goal_completion',
    });

    createFact(entityId, 'goal_outcome', goal.status, {
      confidence: 1.0,
      source: 'goal_completion',
    });

    createFact(entityId, 'goal_level', goal.level, {
      confidence: 1.0,
      source: 'goal_completion',
    });

    if (goal.estimated_hours !== null) {
      createFact(entityId, 'estimated_hours', goal.estimated_hours.toString(), {
        confidence: 1.0,
        source: 'goal_completion',
      });
    }

    if (goal.actual_hours > 0) {
      createFact(entityId, 'actual_hours', goal.actual_hours.toFixed(1), {
        confidence: 1.0,
        source: 'goal_completion',
      });
    }

    // Time to complete
    if (goal.completed_at) {
      const durationDays = Math.ceil((goal.completed_at - goal.created_at) / 86400000);
      createFact(entityId, 'days_to_complete', durationDays.toString(), {
        confidence: 1.0,
        source: 'goal_completion',
      });
    }

    // Estimation accuracy
    if (goal.estimated_hours !== null && goal.actual_hours > 0) {
      const accuracy = (goal.estimated_hours / goal.actual_hours).toFixed(2);
      createFact(entityId, 'estimation_accuracy', accuracy, {
        confidence: 1.0,
        source: 'goal_completion',
      });
    }

    // Tags
    if (goal.tags.length > 0) {
      createFact(entityId, 'goal_tags', goal.tags.join(', '), {
        confidence: 1.0,
        source: 'goal_completion',
      });
    }
  } catch (err) {
    console.error('[Extractor] Failed to extract goal completion:', err);
  }
}
