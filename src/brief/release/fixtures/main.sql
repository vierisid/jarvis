CREATE TABLE agent_activity (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('text', 'tool_call', 'done')),
      data TEXT,
      task_id TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

CREATE TABLE agent_messages (
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
    );

CREATE TABLE app_connection (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    type TEXT NOT NULL,
    scope TEXT NOT NULL CHECK(scope IN ('PROJECT', 'PLATFORM')),
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'MISSING', 'ERROR')),
    piece_name TEXT NOT NULL,
    piece_version TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT,
    value TEXT NOT NULL,
    metadata TEXT,
    pre_select_for_new_projects INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE approval_patterns (
      id TEXT PRIMARY KEY,
      action_category TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      consecutive_approvals INTEGER NOT NULL DEFAULT 0,
      last_approval_at INTEGER NOT NULL,
      suggestion_sent INTEGER NOT NULL DEFAULT 0,
      UNIQUE(action_category, tool_name)
    );

CREATE TABLE approval_requests (
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
    , execution_mode TEXT NOT NULL DEFAULT 'deferred', execution_claimed_at INTEGER, execution_claimed_by TEXT, execution_boot_id TEXT, execution_outcome TEXT, resolved_at INTEGER, resolved_by TEXT, resolution_note TEXT);

CREATE TABLE audit_trail (
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
      created_at INTEGER NOT NULL, channel TEXT,
      CHECK(executed IN (0, 1))
    );

CREATE TABLE awareness_sessions (
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
    );

CREATE TABLE awareness_suggestions (
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
    );

CREATE TABLE commitment_work (
      work_id TEXT PRIMARY KEY REFERENCES commitments(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES goal_check_ins(id),
      action_index INTEGER,
      goal_id TEXT,
      mode TEXT NOT NULL DEFAULT 'manual' CHECK(mode IN ('manual', 'workflow')),
      workflow_id TEXT,
      workflow_version_id TEXT,
      input TEXT NOT NULL DEFAULT '{}',
      decision TEXT,
      run_id TEXT UNIQUE,
      blocker TEXT,
      result_check TEXT,
      updated_at INTEGER NOT NULL,
      UNIQUE(plan_id, action_index)
    );

CREATE TABLE commitments (
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
      sort_order INTEGER DEFAULT 0,
      scope_id TEXT
    );

CREATE TABLE content_attachments (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      disk_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      label TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE content_items (
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
    );

CREATE TABLE content_stage_notes (
      id TEXT PRIMARY KEY,
      content_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
      stage TEXT NOT NULL
        CHECK(stage IN ('idea','research','outline','draft','assets','review','scheduled','published')),
      note TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      channel TEXT,
      started_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      message_count INTEGER DEFAULT 0,
      metadata TEXT,
      sender TEXT,
      CHECK(message_count >= 0)
    );

CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      format TEXT NOT NULL DEFAULT 'markdown'
        CHECK(format IN ('markdown', 'plain', 'html', 'json', 'csv', 'code')),
      tags TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      properties TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT,
      CHECK(type IN ('person', 'project', 'tool', 'place', 'concept', 'event'))
    );

CREATE TABLE fact_evidence (
      id TEXT PRIMARY KEY, fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      source TEXT, source_ref TEXT, quote TEXT, basis TEXT NOT NULL,
      confidence REAL NOT NULL, recorded_at INTEGER NOT NULL, evidence_key TEXT NOT NULL,
      UNIQUE(fact_id, evidence_key)
    );

CREATE TABLE facts (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT,
      created_at INTEGER NOT NULL,
      verified_at INTEGER, predicate_key TEXT, value_key TEXT, scope TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT, valid_from INTEGER, valid_to INTEGER,
      CHECK(confidence >= 0.0 AND confidence <= 1.0)
    );

CREATE TABLE flow (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_id TEXT,
    folder_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('ENABLED', 'DISABLED')),
    operation_status TEXT NOT NULL DEFAULT 'NONE',
    published_version_id TEXT,
    schema_version TEXT,
    template_id TEXT,
    time_saved_per_run INTEGER,
    metadata TEXT,
    -- Per-flow opt-in for CODE steps. A CODE step runs arbitrary JavaScript in
    -- the engine's child process with this machine's privileges, so a flow
    -- containing one is refused at publish until the flag is set FOR THAT FLOW
    -- (see repos/flow-code-steps.ts). Deliberately its own column, not a key
    -- in metadata: the metadata blob is replaced wholesale by
    -- PATCH /api/workflows/:id, and a privilege grant must not be something an
    -- unrelated write can hand out or discard by accident.
    code_steps_enabled INTEGER NOT NULL DEFAULT 0,
    -- 'user' when a human turned it on, 'upgrade' when the flag was
    -- grandfathered onto a flow that was already running CODE before the gate
    -- existed. Kept so the dashboard can show WHY a flow has the permission
    -- and the user can take it back.
    code_steps_grant TEXT,
    code_steps_granted_at INTEGER,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE flow_run (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    flow_version_id TEXT NOT NULL REFERENCES flow_version(id),
    project_id TEXT NOT NULL,
    parent_run_id TEXT,
    fail_parent_on_failure INTEGER NOT NULL DEFAULT 0,
    triggered_by TEXT,
    status TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('PRODUCTION', 'TESTING')),
    steps TEXT,
    failed_step TEXT,
    step_name_to_test TEXT,
    execution_config TEXT,
    start_time INTEGER,
    finish_time INTEGER,
    archived_at INTEGER,
    steps_count INTEGER,
    logs_file_id TEXT,
    tags TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE flow_version (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('DRAFT', 'LOCKED')),
    valid INTEGER NOT NULL DEFAULT 0,
    schema_version TEXT,
    updated_by TEXT,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    connection_ids TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    backup_files TEXT,
    engine_listeners TEXT,
    engine_schedule TEXT,
    sample_data TEXT,
    sample_input TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE flow_version_ui_meta (
    version_id TEXT PRIMARY KEY REFERENCES flow_version(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE goal_check_ins (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL
        CHECK(type IN ('morning_plan', 'evening_review')),
      summary TEXT NOT NULL DEFAULT '',
      goals_reviewed TEXT,
      actions_planned TEXT,
      actions_completed TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE goal_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event TEXT NOT NULL,
    completion_goal TEXT,
    memory_delivered_at INTEGER,
    broadcast_delivered_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER
  );

CREATE TABLE goal_progress (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      type TEXT NOT NULL
        CHECK(type IN ('manual', 'auto_detected', 'review', 'system')),
      score_before REAL NOT NULL,
      score_after REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

CREATE TABLE goal_review_evidence (
    check_in_id TEXT PRIMARY KEY REFERENCES goal_check_ins(id) ON DELETE CASCADE,
    record TEXT NOT NULL
  );

CREATE TABLE goals (
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
    );

CREATE TABLE llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      tier TEXT NOT NULL,
      resolved_tier TEXT NOT NULL,
      subsystem TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error_code TEXT
    );

CREATE TABLE observations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      processed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK(processed IN (0, 1))
    );

CREATE TABLE opportunity_delivery (
    opportunity_id TEXT PRIMARY KEY REFERENCES opportunity_hypotheses(suggestion_id) ON DELETE CASCADE,
    delivered_at INTEGER, channel TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE opportunity_feedback (
    id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunity_hypotheses(suggestion_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('validate', 'dismiss', 'outcome')),
    payload TEXT NOT NULL, work_ref TEXT, created_at INTEGER NOT NULL,
    UNIQUE(opportunity_id, request_id), UNIQUE(opportunity_id, work_ref)
  );

CREATE TABLE opportunity_hypotheses (
    suggestion_id TEXT PRIMARY KEY REFERENCES awareness_suggestions(id) ON DELETE CASCADE,
    pattern_key TEXT NOT NULL UNIQUE, hypothesis TEXT NOT NULL,
    validation TEXT, created_at INTEGER NOT NULL
  );

CREATE TABLE opportunity_observations (
    capture_id TEXT NOT NULL, kind TEXT NOT NULL, observed_at INTEGER NOT NULL,
    app TEXT NOT NULL, cue TEXT NOT NULL, PRIMARY KEY (capture_id, kind)
  );

CREATE TABLE panel_sessions (
      id TEXT PRIMARY KEY,
      sidecar_id TEXT NOT NULL REFERENCES sidecars(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

CREATE TABLE personality_state (
      id TEXT PRIMARY KEY DEFAULT 'default',
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

CREATE TABLE recent_objects (
      id TEXT PRIMARY KEY,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT,
      meta TEXT,
      picked_at INTEGER NOT NULL,
      UNIQUE(object_type, object_id)
    );

CREATE TABLE relationships (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      properties TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE screen_captures (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      session_id TEXT,
      sidecar_id TEXT,
      image_path TEXT,
      pixel_change_pct REAL,
      ocr_text TEXT,
      app_name TEXT,
      window_title TEXT,
      url TEXT,
      file_path TEXT,
      retention_tier TEXT NOT NULL DEFAULT 'full'
        CHECK(retention_tier IN ('full', 'key_moment', 'metadata_only')),
      created_at INTEGER NOT NULL
    , thumbnail_path TEXT);

CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

CREATE TABLE sidecars (
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
    , version TEXT, timezone TEXT);

CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      app TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      match_json TEXT NOT NULL DEFAULT '{}',
      params_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      provenance TEXT NOT NULL DEFAULT 'authored'
        CHECK(provenance IN ('recorded', 'authored', 'marketplace')),
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      content_mac TEXT,
      success_count INTEGER NOT NULL DEFAULT 0,
      run_count INTEGER NOT NULL DEFAULT 0,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(enabled IN (0, 1))
    );

CREATE TABLE store_entry (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE suggestion_composition_jobs (
    id TEXT PRIMARY KEY,
    suggestion_id TEXT NOT NULL UNIQUE REFERENCES awareness_suggestions(id),
    feedback_id TEXT NOT NULL REFERENCES suggestion_feedback(id),
    request TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'failed', 'draft_ready')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    flow_id TEXT,
    version_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((flow_id IS NULL) = (version_id IS NULL))
  );

CREATE TABLE suggestion_feedback (
    id TEXT PRIMARY KEY,
    suggestion_id TEXT NOT NULL REFERENCES awareness_suggestions(id),
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('dismiss', 'interest', 'accept', 'retry')),
    reason TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(suggestion_id, request_id)
  );

CREATE TABLE suggestion_identities (
    suggestion_id TEXT PRIMARY KEY REFERENCES awareness_suggestions(id) ON DELETE CASCADE,
    pattern_key TEXT NOT NULL
  );

CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      tier TEXT NOT NULL,
      template TEXT NOT NULL,
      intent TEXT NOT NULL,
      original_message TEXT,
      subsystem TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      result_json TEXT,
      question TEXT,
      paused_conversation TEXT,
      context_key TEXT
    );

CREATE TABLE trigger_event (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    source_name TEXT,
    consumed INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  );

CREATE TABLE vectors (
      id TEXT PRIMARY KEY,
      ref_type TEXT,
      ref_id TEXT,
      embedding BLOB,
      model TEXT,
      created_at INTEGER NOT NULL
    );

CREATE TABLE waitpoint (
    id TEXT PRIMARY KEY,
    flow_run_id TEXT NOT NULL REFERENCES flow_run(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    step_name TEXT NOT NULL,
    type TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT 'V1',
    resume_date_time TEXT,
    response_to_send TEXT,
    worker_handler_id TEXT,
    http_request_id TEXT,
    created INTEGER NOT NULL,
    resumed_at INTEGER
  );

CREATE TABLE webapp_templates (
      id TEXT PRIMARY KEY,
      app_name TEXT NOT NULL UNIQUE,
      domains TEXT NOT NULL,
      keywords TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(enabled IN (0, 1))
    );

CREATE TABLE workflow_composition (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    specification TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('COMPOSING', 'VALIDATED', 'FAILED')),
    previous_response TEXT,
    previous_graph TEXT,
    errors TEXT NOT NULL DEFAULT '[]',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE workflow_delegation (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES flow_run(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    record TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE workflow_effect (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES flow_run(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    approval_id TEXT,
    waitpoint_id TEXT,
    record TEXT NOT NULL
  );

CREATE TABLE workflow_executions (
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
    );

CREATE TABLE workflow_file (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    flow_id TEXT,
    type TEXT NOT NULL,
    file_name TEXT,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    metadata TEXT,
    created INTEGER NOT NULL
  );

CREATE TABLE workflow_job (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    flow_run_id TEXT,
    flow_id TEXT,
    flow_version_id TEXT,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED')),
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    locked_until INTEGER,
    scheduled_at INTEGER NOT NULL,
    last_error TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );

CREATE TABLE workflow_run_cancellation (
    run_id TEXT PRIMARY KEY REFERENCES flow_run(id) ON DELETE CASCADE,
    acknowledged_at INTEGER NOT NULL,
    status_at_request TEXT NOT NULL,
    in_flight_may_have_completed INTEGER NOT NULL
  );

CREATE TABLE workflow_run_machine_binding (
    run_id TEXT PRIMARY KEY REFERENCES flow_run(id) ON DELETE CASCADE,
    record TEXT NOT NULL
  );

CREATE TABLE workflow_step_results (
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
    );

CREATE TABLE workflow_variables (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workflow_id, key)
    );

CREATE TABLE workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      definition TEXT NOT NULL,
      changelog TEXT,
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      UNIQUE(workflow_id, version)
    );

CREATE TABLE workflows (
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
    );

CREATE INDEX idx_agent_activity_agent_id ON agent_activity(agent_id, timestamp DESC);

CREATE INDEX idx_agent_activity_timestamp ON agent_activity(timestamp DESC);

CREATE INDEX idx_app_connection_piece ON app_connection(piece_name);

CREATE INDEX idx_app_connection_project ON app_connection(project_id);

CREATE INDEX idx_approval_agent ON approval_requests(agent_id);

CREATE INDEX idx_approval_category ON approval_requests(action_category);

CREATE INDEX idx_approval_created ON approval_requests(created_at);

CREATE INDEX idx_approval_status ON approval_requests(status);

CREATE INDEX idx_attachments_content ON content_attachments(content_id);

CREATE INDEX idx_audit_agent ON audit_trail(agent_id);

CREATE INDEX idx_audit_category ON audit_trail(action_category);

CREATE INDEX idx_audit_created ON audit_trail(created_at);

CREATE INDEX idx_captures_app ON screen_captures(app_name);

CREATE INDEX idx_captures_retention ON screen_captures(retention_tier);

CREATE INDEX idx_captures_session ON screen_captures(session_id);

CREATE INDEX idx_captures_timestamp ON screen_captures(timestamp);

CREATE INDEX idx_commitments_due ON commitments(when_due)
  ;

CREATE INDEX idx_commitments_sort ON commitments(status, sort_order)
  ;

CREATE INDEX idx_commitments_status ON commitments(status)
  ;

CREATE INDEX idx_content_sort ON content_items(stage, sort_order);

CREATE INDEX idx_content_stage ON content_items(stage);

CREATE INDEX idx_content_type ON content_items(content_type);

CREATE INDEX idx_conv_msg_conv ON conversation_messages(conversation_id)
  ;

CREATE INDEX idx_conv_msg_time ON conversation_messages(created_at)
  ;

CREATE INDEX idx_conversations_agent ON conversations(agent_id)
  ;

CREATE INDEX idx_conversations_channel ON conversations(channel)
  ;

CREATE INDEX idx_conversations_sender
      ON conversations(channel, sender, last_message_at)
  ;

CREATE INDEX idx_documents_format ON documents(format);

CREATE INDEX idx_documents_updated ON documents(updated_at);

CREATE INDEX idx_entities_name ON entities(name)
  ;

CREATE INDEX idx_entities_type ON entities(type)
  ;

CREATE INDEX idx_fact_evidence_fact ON fact_evidence(fact_id);

CREATE INDEX idx_facts_identity ON facts(subject_id, predicate_key, scope, value_key);

CREATE INDEX idx_facts_predicate ON facts(predicate)
  ;

CREATE INDEX idx_facts_subject ON facts(subject_id)
  ;

CREATE INDEX idx_flow_project ON flow(project_id);

CREATE INDEX idx_flow_run_flow ON flow_run(flow_id);

CREATE INDEX idx_flow_run_parent ON flow_run(parent_run_id);

CREATE INDEX idx_flow_run_project ON flow_run(project_id);

CREATE INDEX idx_flow_run_started ON flow_run(start_time);

CREATE INDEX idx_flow_run_status ON flow_run(status);

CREATE INDEX idx_flow_status ON flow(status);

CREATE INDEX idx_flow_version_flow ON flow_version(flow_id);

CREATE INDEX idx_flow_version_state ON flow_version(state);

CREATE INDEX idx_gci_created ON goal_check_ins(created_at);

CREATE INDEX idx_gci_type ON goal_check_ins(type);

CREATE INDEX idx_goal_events_broadcast ON goal_events(sequence) WHERE broadcast_delivered_at IS NULL;

CREATE INDEX idx_goal_events_created ON goal_events(created_at);

CREATE INDEX idx_goal_events_memory ON goal_events(attempts, sequence) WHERE completion_goal IS NOT NULL AND memory_delivered_at IS NULL;

CREATE INDEX idx_goals_deadline ON goals(deadline);

CREATE INDEX idx_goals_health ON goals(health);

CREATE INDEX idx_goals_level ON goals(level);

CREATE INDEX idx_goals_parent ON goals(parent_id);

CREATE INDEX idx_goals_status ON goals(status);

CREATE INDEX idx_gprog_created ON goal_progress(created_at);

CREATE INDEX idx_gprog_goal ON goal_progress(goal_id);

CREATE INDEX idx_llm_usage_subsystem ON llm_usage(subsystem, ts DESC);

CREATE INDEX idx_llm_usage_tier ON llm_usage(tier, ts DESC);

CREATE INDEX idx_llm_usage_ts ON llm_usage(ts DESC);

CREATE INDEX idx_msg_from ON agent_messages(from_agent)
  ;

CREATE INDEX idx_msg_to ON agent_messages(to_agent)
  ;

CREATE INDEX idx_obs_processed ON observations(processed)
  ;

CREATE INDEX idx_obs_type ON observations(type)
  ;

CREATE INDEX idx_opportunity_observations_time ON opportunity_observations(observed_at);

CREATE INDEX idx_panel_sessions_sidecar ON panel_sessions(sidecar_id);

CREATE INDEX idx_recent_objects_picked ON recent_objects(picked_at DESC);

CREATE INDEX idx_rel_from ON relationships(from_id)
  ;

CREATE INDEX idx_rel_to ON relationships(to_id)
  ;

CREATE INDEX idx_rel_type ON relationships(type)
  ;

CREATE INDEX idx_sessions_started ON awareness_sessions(started_at);

CREATE INDEX idx_sessions_topic ON awareness_sessions(topic);

CREATE INDEX idx_sidecars_name ON sidecars(name);

CREATE INDEX idx_sidecars_token_id ON sidecars(token_id);

CREATE INDEX idx_skills_app ON skills(app);

CREATE INDEX idx_skills_enabled ON skills(enabled);

CREATE INDEX idx_skills_name ON skills(name);

CREATE INDEX idx_stage_notes_content ON content_stage_notes(content_id);

CREATE INDEX idx_suggestion_composition_state ON suggestion_composition_jobs(state, created_at);

CREATE INDEX idx_suggestion_identity_pattern ON suggestion_identities(pattern_key);

CREATE INDEX idx_suggestions_created ON awareness_suggestions(created_at);

CREATE INDEX idx_suggestions_type ON awareness_suggestions(type);

CREATE INDEX idx_tasks_status_updated ON tasks(status, updated_at DESC);

CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);

CREATE INDEX idx_trigger_event_consumed ON trigger_event(consumed, created);

CREATE INDEX idx_trigger_event_flow ON trigger_event(flow_id);

CREATE INDEX idx_vectors_ref ON vectors(ref_type, ref_id)
  ;

CREATE INDEX idx_waitpoint_run_step ON waitpoint(flow_run_id, step_name);

CREATE INDEX idx_we_started ON workflow_executions(started_at);

CREATE INDEX idx_we_status ON workflow_executions(status);

CREATE INDEX idx_we_workflow ON workflow_executions(workflow_id);

CREATE INDEX idx_webapp_app_name ON webapp_templates(app_name);

CREATE INDEX idx_webapp_enabled ON webapp_templates(enabled);

CREATE INDEX idx_work_goal ON commitment_work(goal_id);

CREATE INDEX idx_work_plan ON commitment_work(plan_id);

CREATE INDEX idx_workflow_delegation_run ON workflow_delegation(run_id);

CREATE INDEX idx_workflow_effect_pending ON workflow_effect(status);

CREATE INDEX idx_workflow_effect_run ON workflow_effect(run_id);

CREATE INDEX idx_workflow_file_flow ON workflow_file(flow_id);

CREATE INDEX idx_workflow_file_project ON workflow_file(project_id);

CREATE INDEX idx_workflow_job_claim ON workflow_job(status, scheduled_at, priority);

CREATE INDEX idx_workflow_job_flow_run ON workflow_job(flow_run_id);

CREATE INDEX idx_workflows_enabled ON workflows(enabled);

CREATE INDEX idx_workflows_updated ON workflows(updated_at);

CREATE INDEX idx_wsr_execution ON workflow_step_results(execution_id);

CREATE INDEX idx_wsr_node ON workflow_step_results(node_id);

CREATE INDEX idx_wv_version ON workflow_versions(workflow_id, version);

CREATE INDEX idx_wv_workflow ON workflow_versions(workflow_id);

CREATE INDEX idx_wvar_workflow ON workflow_variables(workflow_id);

CREATE UNIQUE INDEX uq_app_connection_external ON app_connection(project_id, piece_name, external_id);

CREATE UNIQUE INDEX uq_flow_external ON flow(project_id, external_id);

CREATE UNIQUE INDEX uq_store_entry_project_key ON store_entry(project_id, key);
