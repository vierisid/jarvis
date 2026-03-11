import { Database } from "bun:sqlite";

let dbInstance: Database | null = null;

/**
 * Generate a short unique ID for database records
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get the current database instance (singleton)
 * @throws Error if database has not been initialized
 */
export function getDb(): Database {
  if (!dbInstance) {
    throw new Error(
      "Database not initialized. Call initDatabase() first."
    );
  }
  return dbInstance;
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Initialize the SQLite database with all required tables
 * @param dbPath - Path to the database file. Defaults to :memory: for testing
 * @returns Database instance
 */
export function initDatabase(dbPath: string = ":memory:"): Database {
  try {
    // Close existing connection if any
    closeDb();

    // Create new database connection
    dbInstance = new Database(dbPath, { create: true });

    // Enable WAL mode for better concurrency
    dbInstance.exec("PRAGMA journal_mode=WAL");

    // Enable foreign key constraints
    dbInstance.exec("PRAGMA foreign_keys=ON");

    // Create all tables
    createTables(dbInstance);

    console.log(`Database initialized at: ${dbPath}`);
    return dbInstance;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize database: ${message}`);
  }
}

/**
 * Create all database tables and indexes
 */
function createTables(db: Database): void {
  // Entities table: people, places, projects, tools, concepts
  db.run(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      properties TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT,
      CHECK(type IN ('person', 'project', 'tool', 'place', 'concept', 'event'))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name)
  `);

  // Facts table: atomic pieces of knowledge with confidence
  db.run(`
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER NOT NULL,
      verified_at INTEGER,
      CHECK(confidence >= 0.0 AND confidence <= 1.0)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)
  `);

  // Relationships table: edges between entities
  db.run(`
    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      properties TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_rel_from ON relationships(from_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_rel_to ON relationships(to_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(type)
  `);

  // Commitments table: things the AI promised to do
  db.run(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      what TEXT NOT NULL,
      when_due INTEGER,
      context TEXT,
      priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high','critical')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','completed','failed','escalated')),
      retry_policy TEXT,
      created_from TEXT,
      assigned_to TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // Migration: add sort_order to existing databases
  try { db.run('ALTER TABLE commitments ADD COLUMN sort_order INTEGER DEFAULT 0'); } catch {}

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_commitments_due ON commitments(when_due)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_commitments_sort ON commitments(status, sort_order)
  `);

  // Observations table: raw events from the observation layer
  db.run(`
    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      processed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK(processed IN (0, 1))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_obs_processed ON observations(processed)
  `);

  // Vectors table: embeddings for semantic search
  db.run(`
    CREATE TABLE IF NOT EXISTS vectors (
      id TEXT PRIMARY KEY,
      ref_type TEXT,
      ref_id TEXT,
      embedding BLOB,
      model TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_vectors_ref ON vectors(ref_type, ref_id)
  `);

  // Agent messages table: inter-agent communication
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('task','report','question','escalation')),
      content TEXT NOT NULL,
      priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      requires_response INTEGER DEFAULT 0,
      deadline INTEGER,
      created_at INTEGER NOT NULL,
      CHECK(requires_response IN (0, 1))
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_msg_to ON agent_messages(to_agent)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_msg_from ON agent_messages(from_agent)
  `);

  // Personality state table
  db.run(`
    CREATE TABLE IF NOT EXISTS personality_state (
      id TEXT PRIMARY KEY DEFAULT 'default',
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Conversations table: context tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      channel TEXT,
      started_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      message_count INTEGER DEFAULT 0,
      metadata TEXT,
      CHECK(message_count >= 0)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel)
  `);

  // Conversation messages table: individual chat messages
  db.run(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_conv_msg_conv ON conversation_messages(conversation_id)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_conv_msg_time ON conversation_messages(created_at)
  `);

  // Content pipeline: items moving through creation stages
  db.run(`
    CREATE TABLE IF NOT EXISTS content_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      content_type TEXT NOT NULL DEFAULT 'blog'
        CHECK(content_type IN ('youtube','blog','twitter','instagram','tiktok','linkedin','podcast','newsletter','short_form','other')),
      stage TEXT NOT NULL DEFAULT 'idea'
        CHECK(stage IN ('idea','research','outline','draft','assets','review','scheduled','published')),
      tags TEXT,
      scheduled_at INTEGER,
      published_at INTEGER,
      published_url TEXT,
      created_by TEXT DEFAULT 'user',
      sort_order INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_content_stage ON content_items(stage)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_content_type ON content_items(content_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_content_sort ON content_items(stage, sort_order)`);

  // Content pipeline: per-stage notes from user or JARVIS
  db.run(`
    CREATE TABLE IF NOT EXISTS content_stage_notes (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      stage TEXT NOT NULL
        CHECK(stage IN ('idea','research','outline','draft','assets','review','scheduled','published')),
      note TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_stage_notes_content ON content_stage_notes(content_id)`);

  // Content pipeline: file/image attachments (files stored on disk)
  db.run(`
    CREATE TABLE IF NOT EXISTS content_attachments (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      disk_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_attachments_content ON content_attachments(content_id)`);

  // Authority: Approval requests
  db.run(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_arguments TEXT NOT NULL,
      action_category TEXT NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'normal'
        CHECK(urgency IN ('urgent', 'normal')),
      reason TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'executed')),
      decided_at INTEGER,
      decided_by TEXT,
      executed_at INTEGER,
      execution_result TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_approval_agent ON approval_requests(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_approval_category ON approval_requests(action_category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_approval_created ON approval_requests(created_at)`);

  // Authority: Audit trail
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_trail (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      action_category TEXT NOT NULL,
      authority_decision TEXT NOT NULL
        CHECK(authority_decision IN ('allowed', 'denied', 'approval_required')),
      approval_id TEXT,
      executed INTEGER NOT NULL DEFAULT 0,
      execution_time_ms INTEGER,
      created_at INTEGER NOT NULL,
      CHECK(executed IN (0, 1))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_trail(agent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_trail(action_category)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_trail(created_at)`);

  // Authority: Approval patterns (for learning)
  db.run(`
    CREATE TABLE IF NOT EXISTS approval_patterns (
      id TEXT PRIMARY KEY,
      action_category TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      consecutive_approvals INTEGER NOT NULL DEFAULT 0,
      last_approval_at INTEGER NOT NULL,
      suggestion_sent INTEGER NOT NULL DEFAULT 0,
      UNIQUE(action_category, tool_name)
    )
  `);

  // ── Awareness (M13): Screen captures, sessions, suggestions ──

  db.run(`
    CREATE TABLE IF NOT EXISTS screen_captures (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      image_path TEXT,
      thumbnail_path TEXT,
      pixel_change_pct REAL,
      ocr_text TEXT,
      app_name TEXT,
      window_title TEXT,
      url TEXT,
      file_path TEXT,
      retention_tier TEXT NOT NULL DEFAULT 'full'
        CHECK(retention_tier IN ('full', 'key_moment', 'metadata_only')),
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON screen_captures(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_captures_session ON screen_captures(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_captures_retention ON screen_captures(retention_tier)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_captures_app ON screen_captures(app_name)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS awareness_sessions (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      topic TEXT,
      apps TEXT,
      project_context TEXT,
      action_types TEXT,
      entity_links TEXT,
      summary TEXT,
      capture_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_started ON awareness_sessions(started_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_topic ON awareness_sessions(topic)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS awareness_suggestions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('error', 'stuck', 'automation', 'knowledge', 'schedule', 'break', 'general')),
      trigger_capture_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      context TEXT,
      delivered INTEGER DEFAULT 0,
      delivered_at INTEGER,
      delivery_channel TEXT,
      dismissed INTEGER DEFAULT 0,
      acted_on INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK(delivered IN (0, 1)),
      CHECK(dismissed IN (0, 1)),
      CHECK(acted_on IN (0, 1))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_suggestions_type ON awareness_suggestions(type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_suggestions_created ON awareness_suggestions(created_at)`);

  // ── Workflows (M14): Automation engine ──

  db.run(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      authority_level INTEGER NOT NULL DEFAULT 3,
      authority_approved INTEGER NOT NULL DEFAULT 0,
      approved_at INTEGER,
      approved_by TEXT,
      tags TEXT,
      current_version INTEGER NOT NULL DEFAULT 1,
      execution_count INTEGER NOT NULL DEFAULT 0,
      last_executed_at INTEGER,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(enabled IN (0, 1)),
      CHECK(authority_approved IN (0, 1))
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_enabled ON workflows(enabled)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      changelog TEXT,
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      UNIQUE(workflow_id, version)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wv_workflow ON workflow_versions(workflow_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wv_version ON workflow_versions(workflow_id, version)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_data TEXT,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'paused')),
      variables TEXT,
      error_message TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_we_workflow ON workflow_executions(workflow_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_we_status ON workflow_executions(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_we_started ON workflow_executions(started_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_step_results (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'waiting')),
      input_data TEXT,
      output_data TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wsr_execution ON workflow_step_results(execution_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wsr_node ON workflow_step_results(node_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_variables (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workflow_id, key)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_wvar_workflow ON workflow_variables(workflow_id)`);

  // ── M16: Goal Pursuit ─────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES goals(id) ON DELETE CASCADE,
      level TEXT NOT NULL
        CHECK(level IN ('objective', 'key_result', 'milestone', 'task', 'daily_action')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      success_criteria TEXT DEFAULT '',
      time_horizon TEXT NOT NULL DEFAULT 'quarterly'
        CHECK(time_horizon IN ('life', 'yearly', 'quarterly', 'monthly', 'weekly', 'daily')),
      score REAL NOT NULL DEFAULT 0.0,
      score_reason TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft', 'active', 'paused', 'completed', 'failed', 'killed')),
      health TEXT NOT NULL DEFAULT 'on_track'
        CHECK(health IN ('on_track', 'at_risk', 'behind', 'critical')),
      deadline INTEGER,
      started_at INTEGER,
      estimated_hours REAL,
      actual_hours REAL NOT NULL DEFAULT 0,
      authority_level INTEGER NOT NULL DEFAULT 3,
      tags TEXT,
      dependencies TEXT,
      escalation_stage TEXT NOT NULL DEFAULT 'none'
        CHECK(escalation_stage IN ('none', 'pressure', 'root_cause', 'suggest_kill')),
      escalation_started_at INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_level ON goals(level)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_health ON goals(health)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_goals_deadline ON goals(deadline)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS goal_progress (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      type TEXT NOT NULL
        CHECK(type IN ('manual', 'auto_detected', 'review', 'system')),
      score_before REAL NOT NULL,
      score_after REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gprog_goal ON goal_progress(goal_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gprog_created ON goal_progress(created_at)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS goal_check_ins (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL
        CHECK(type IN ('morning_plan', 'evening_review')),
      summary TEXT NOT NULL DEFAULT '',
      goals_reviewed TEXT,
      actions_planned TEXT,
      actions_completed TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gci_type ON goal_check_ins(type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gci_created ON goal_check_ins(created_at)`);

  // Sidecars table: enrolled sidecar processes
  db.run(`
    CREATE TABLE IF NOT EXISTS sidecars (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      token_id TEXT NOT NULL UNIQUE,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      status TEXT NOT NULL DEFAULT 'enrolled'
        CHECK(status IN ('enrolled', 'revoked')),
      hostname TEXT,
      os TEXT,
      platform TEXT,
      capabilities TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sidecars_name ON sidecars(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sidecars_token_id ON sidecars(token_id)`);

  // Settings table: key-value store for dashboard-managed configuration
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}
