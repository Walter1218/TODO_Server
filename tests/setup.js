const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

let testDb;
let testDbPath;

function createTestDb() {
  testDbPath = path.join(__dirname, '..', 'data', `test-${process.env.JEST_WORKER_ID || '0'}.db`);
  const db = new Database(testDbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function initTestSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      secret_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      color TEXT DEFAULT '#667eea',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      project_id TEXT,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      context TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      dependencies TEXT DEFAULT '[]',
      acceptance_criteria TEXT DEFAULT '',
      criteria_confirmed BOOLEAN DEFAULT false,
      max_attempts INTEGER DEFAULT 3,
      attempt_count INTEGER DEFAULT 0,
      attempt_log TEXT DEFAULT '[]',
      last_heartbeat DATETIME,
      heartbeat_progress REAL DEFAULT 0,
      heartbeat_step TEXT DEFAULT '',
      heartbeat_blockers TEXT DEFAULT '[]',
      position INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      expected_duration_minutes INTEGER,
      task_spec TEXT,
      schedule TEXT,
      is_template BOOLEAN DEFAULT 0,
      origin_agent_id TEXT,
      assigned_agent_id TEXT,
      assignment_note TEXT DEFAULT '',
      assigned_at DATETIME,
      transferred_from TEXT,
      archived BOOLEAN DEFAULT 0,
      next_due_at DATETIME,
      last_spawned_at DATETIME,
      last_driven_at DATETIME,
      validation_report TEXT DEFAULT '',
      validated_by TEXT,
      validation_count INTEGER DEFAULT 0,
      validation_deadline DATETIME,
      task_category TEXT DEFAULT 'general',
      failure_bucket TEXT,
      circuit_open_until DATETIME,
      last_preflight_at DATETIME,
      last_preflight_status TEXT,
      last_preflight_report TEXT DEFAULT '',
      completion_report TEXT,
      requires_plan BOOLEAN DEFAULT 0,
      plan_status TEXT DEFAULT 'not_required',
      current_plan_id TEXT,
      current_step_id TEXT,
      execution_state TEXT DEFAULT 'idle',
      lease_expires_at DATETIME,
      last_action_at DATETIME,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS focus_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      current_task_id TEXT,
      focus_mode TEXT DEFAULT 'auto',
      context_window_size INTEGER DEFAULT 10,
      last_focused_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (current_task_id) REFERENCES todos(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT,
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_notifications (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      type TEXT,
      message TEXT NOT NULL,
      read BOOLEAN DEFAULT false,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL UNIQUE,
      template_id TEXT,
      planned_at DATETIME,
      spawned_at DATETIME,
      started_at DATETIME,
      first_heartbeat_at DATETIME,
      pending_validation_at DATETIME,
      completed_at DATETIME,
      validated_at DATETIME,
      final_status TEXT DEFAULT 'pending',
      failure_bucket TEXT,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduler_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      template_id TEXT,
      task_id TEXT,
      event_type TEXT NOT NULL,
      event_status TEXT DEFAULT 'info',
      details TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_plans (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      revision INTEGER DEFAULT 1,
      status TEXT DEFAULT 'draft',
      source TEXT DEFAULT 'system_rule',
      summary TEXT DEFAULT '',
      review_notes TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      approved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      step_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      instruction TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      completion_notes TEXT DEFAULT '',
      metadata TEXT DEFAULT '{}',
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      plan_id TEXT,
      step_id TEXT,
      event_type TEXT NOT NULL,
      event_status TEXT DEFAULT 'info',
      details TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function setupTestDb() {
  if (testDb) {
    try { testDb.close(); } catch(e) {}
  }

  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'test.db')); } catch(e) {}
  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'test.db-wal')); } catch(e) {}
  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'test.db-shm')); } catch(e) {}

  testDb = createTestDb();
  initTestSchema(testDb);

  const dbModule = require('../src/db');
  dbModule._testDb = testDb;

  return testDb;
}

function clearAllTables(db) {
  db.exec(`
    DELETE FROM scheduler_events;
    DELETE FROM task_events;
    DELETE FROM task_plan_steps;
    DELETE FROM task_plans;
    DELETE FROM job_runs;
    DELETE FROM task_notifications;
    DELETE FROM contexts;
    DELETE FROM focus_states;
    DELETE FROM todos;
    DELETE FROM projects;
    DELETE FROM agents;
  `);
}

function closeTestDb() {
  if (testDb) {
    testDb.close();
    testDb = null;
  }
  if (testDbPath) {
    try { fs.unlinkSync(testDbPath); } catch(e) {}
    try { fs.unlinkSync(testDbPath + '-wal'); } catch(e) {}
    try { fs.unlinkSync(testDbPath + '-shm'); } catch(e) {}
    testDbPath = null;
  }
}

module.exports = {
  setupTestDb,
  clearAllTables,
  closeTestDb,
  getTestDb: () => testDb
};
