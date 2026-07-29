/**
 * Vault Module - Data Access Layer for J.A.R.V.I.S. Knowledge Graph
 *
 * This module provides CRUD operations for all core data types in the knowledge graph:
 * - Entities: People, projects, tools, places, concepts, events
 * - Facts: Atomic pieces of knowledge with confidence scores
 * - Relationships: Typed edges between entities
 * - Commitments: Promises and tasks the AI needs to fulfill
 * - Observations: Raw events from the observation layer
 * - Vectors: Embeddings for semantic search
 *
 * All modules use Bun's SQLite API and handle JSON serialization automatically.
 */

// Re-export schema utilities
export { initDatabase, getDb, closeDb, generateId } from './schema.ts';

// Re-export entities module
export type { Entity, EntityType } from './entities.ts';
export {
  createEntity,
  getEntity,
  findEntities,
  updateEntity,
  deleteEntity,
  searchEntitiesByName,
} from './entities.ts';

// Re-export facts module
export type { Fact } from './facts.ts';
export {
  createFact,
  getFact,
  findFacts,
  queryFact,
  updateFact,
  deleteFact,
  verifyFact,
} from './facts.ts';

// Re-export relationships module
export type { Relationship } from './relationships.ts';
export {
  createRelationship,
  getRelationship,
  findRelationships,
  getEntityRelationships,
  deleteRelationship,
} from './relationships.ts';

// Re-export commitments module
export type { Commitment, CommitmentPriority, CommitmentStatus, RetryPolicy } from './commitments.ts';
export {
  createCommitment,
  getCommitment,
  findCommitments,
  getUpcoming,
  completeCommitment,
  failCommitment,
  escalateCommitment,
  getDueCommitments,
} from './commitments.ts';

// Re-export observations module
export type { Observation, ObservationType } from './observations.ts';
export {
  createObservation,
  getUnprocessed,
  markProcessed,
  getRecentObservations,
} from './observations.ts';

// Re-export vectors module
export type { VectorRecord, SimilarityMatch } from './vectors.ts';
export {
  storeVector,
  findSimilar,
  findSimilarByRef,
  deleteVectors,
  countVectors,
} from './vectors.ts';

// Re-export extractor module
export type { ExtractionResult } from './extractor.ts';
export {
  buildExtractionPrompt,
  parseExtractionResponse,
  extractAndStore,
} from './extractor.ts';
