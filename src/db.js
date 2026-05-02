const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'todo.db');

let db;

function getDb() {
  if (module.exports._testDb) return module.exports._testDb;
  if (!db) {
    const fs = require('fs');
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initializeSchema();
  }
  return db;
}

function initializeSchema() {
  const database = db;

    database.exec(`
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
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
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
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_todos_agent_id ON todos(agent_id);
    CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id);
    CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
    CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
    CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_agent_id ON projects(agent_id);

    -- Focus states: per-agent current focus tracking
    CREATE TABLE IF NOT EXISTS focus_states (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL UNIQUE,
      current_task_id TEXT,
      focus_mode TEXT DEFAULT 'auto' CHECK(focus_mode IN ('auto', 'manual', 'pinned')),
      context_window_size INTEGER DEFAULT 10,
      last_focused_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (current_task_id) REFERENCES todos(id) ON DELETE SET NULL
    );

    -- Contexts: conversation history per session
    CREATE TABLE IF NOT EXISTS contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_contexts_agent_session ON contexts(agent_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_contexts_created_at ON contexts(created_at);
  `);

  // Migration: add secret_key column to existing agents (safe to run on every startup)
  try {
    database.exec("ALTER TABLE agents ADD COLUMN secret_key TEXT");
    database.exec("UPDATE agents SET secret_key = hex(randomblob(16)) WHERE secret_key IS NULL OR secret_key = ''");
    console.log('[DB] Migration: secret_key column added');
  } catch (err) {
    // Column already exists, that's fine
  }

  // Migration: add new columns to todos for acceptance criteria, retry tracking, heartbeat
  const todoMigrations = [
    { col: 'parent_id', type: 'TEXT' },
    { col: 'acceptance_criteria', type: 'TEXT' },
    { col: 'criteria_confirmed', type: 'BOOLEAN DEFAULT false' },
    { col: 'max_attempts', type: 'INTEGER DEFAULT 3' },
    { col: 'attempt_count', type: 'INTEGER DEFAULT 0' },
    { col: 'attempt_log', type: 'TEXT DEFAULT \'[]\'' },
    { col: 'last_heartbeat', type: 'DATETIME' },
    { col: 'heartbeat_progress', type: 'REAL DEFAULT 0' },
    { col: 'heartbeat_step', type: 'TEXT DEFAULT \'\'' },
    { col: 'heartbeat_blockers', type: 'TEXT DEFAULT \'[]\'' },
  ];

  for (const mig of todoMigrations) {
    try {
      database.exec(`ALTER TABLE todos ADD COLUMN ${mig.col} ${mig.type}`);
      console.log(`[DB] Migration: todos.${mig.col} added`);
    } catch (err) {
      // Column already exists, that's fine
    }
  }

  // Migration: create index on parent_id after column is guaranteed to exist
  try {
    database.exec('CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id)');
    console.log('[DB] Migration: idx_todos_parent_id created');
  } catch (err) {
    console.log('[DB] Migration: idx_todos_parent_id skipped:', err.message);
  }

  // Migration: add scheduled task columns
  const scheduledMigrations = [
    { col: 'schedule', type: 'TEXT' },
    { col: 'is_template', type: 'BOOLEAN DEFAULT 0' },
  ];

  for (const mig of scheduledMigrations) {
    try {
      database.exec(`ALTER TABLE todos ADD COLUMN ${mig.col} ${mig.type}`);
      console.log(`[DB] Migration: todos.${mig.col} added`);
    } catch (err) {
      // Column already exists
    }
  }

  // Migration: add multi-agent collaboration columns
  const collaborationMigrations = [
    { col: 'origin_agent_id', type: 'TEXT' },
    { col: 'assigned_agent_id', type: 'TEXT' },
    { col: 'assignment_note', type: "TEXT DEFAULT ''" },
    { col: 'assigned_at', type: 'DATETIME' },
    { col: 'transferred_from', type: 'TEXT' },
  ];

  for (const mig of collaborationMigrations) {
    try {
      database.exec(`ALTER TABLE todos ADD COLUMN ${mig.col} ${mig.type}`);
      console.log(`[DB] Migration: todos.${mig.col} added`);
    } catch (err) {
      // Column already exists
    }
  }

  // Migration: add archived flag for cleanup strategy
  try {
    database.exec("ALTER TABLE todos ADD COLUMN archived BOOLEAN DEFAULT 0");
    console.log('[DB] Migration: todos.archived added');
  } catch (err) {
    // Column already exists
  }

  // Migration: add recurring task scheduler columns
  const schedulerMigrations = [
    { col: 'next_due_at', type: 'DATETIME' },
    { col: 'last_spawned_at', type: 'DATETIME' },
  ];

  for (const mig of schedulerMigrations) {
    try {
      database.exec(`ALTER TABLE todos ADD COLUMN ${mig.col} ${mig.type}`);
      console.log(`[DB] Migration: todos.${mig.col} added`);
    } catch (err) {
      // Column already exists
    }
  }

  // Index for efficient scheduler queries
  try {
    database.exec('CREATE INDEX IF NOT EXISTS idx_todos_template_due ON todos(is_template, next_due_at)');
    console.log('[DB] Migration: idx_todos_template_due created');
  } catch (err) {
    console.log('[DB] Migration: idx_todos_template_due skipped:', err.message);
  }

  // Create task notifications table for cross-agent collaboration
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_notifications (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      type TEXT CHECK(type IN ('assigned', 'completed', 'transferred', 'comment', 'recovered', 'blocked', 'stalled')),
      message TEXT NOT NULL,
      read BOOLEAN DEFAULT false,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_agent ON task_notifications(agent_id, read);
    CREATE INDEX IF NOT EXISTS idx_notifications_task ON task_notifications(task_id);
  `);

  // Migration: update status CHECK constraint to include 'blocked'
  // SQLite doesn't support ALTER CHECK, but we can validate in application layer

  // Migration: expand task_notifications type CHECK constraint to include 'recovered', 'blocked', 'stalled'
  try {
    const tblInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_notifications'").get();
    if (tblInfo && tblInfo.sql && !tblInfo.sql.includes('stalled')) {
      db.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN TRANSACTION;
        CREATE TABLE task_notifications_new (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          type TEXT CHECK(type IN ('assigned', 'completed', 'transferred', 'comment', 'recovered', 'blocked', 'stalled')),
          message TEXT NOT NULL,
          read BOOLEAN DEFAULT false,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES todos(id) ON DELETE CASCADE
        );
        INSERT INTO task_notifications_new SELECT * FROM task_notifications;
        DROP TABLE task_notifications;
        ALTER TABLE task_notifications_new RENAME TO task_notifications;
        CREATE INDEX IF NOT EXISTS idx_notifications_agent ON task_notifications(agent_id, read);
        CREATE INDEX IF NOT EXISTS idx_notifications_task ON task_notifications(task_id);
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
      console.log('[DB] Migration: task_notifications CHECK constraint updated');
    }
  } catch (err) {
    console.log('[DB] Migration: task_notifications CHECK constraint skipped:', err.message);
  }

  // Migration: add expected_duration_minutes column
  try {
    db.prepare(`ALTER TABLE todos ADD COLUMN expected_duration_minutes INTEGER`).run();
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add last_driven_at column for DriveOrchestrator cooldown
  try {
    db.prepare(`ALTER TABLE todos ADD COLUMN last_driven_at DATETIME`).run();
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: add Agent-to-Agent validation columns
  const validationMigrations = [
    { col: 'validation_report', type: 'TEXT' },
    { col: 'validated_by', type: 'TEXT' },
    { col: 'validation_count', type: 'INTEGER DEFAULT 0' },
  ];

  for (const mig of validationMigrations) {
    try {
      database.exec(`ALTER TABLE todos ADD COLUMN ${mig.col} ${mig.type}`);
      console.log(`[DB] Migration: todos.${mig.col} added`);
    } catch (err) {
      // Column already exists
    }
  }

  // Migration: update status CHECK constraint for todos to include validation states
  try {
    const tblInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='todos'").get();
    if (tblInfo && tblInfo.sql && !tblInfo.sql.includes('pending_validation')) {
      console.log('[DB] Migration: Updating todos status CHECK constraint...');
      db.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN TRANSACTION;
        CREATE TABLE todos_new (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          project_id TEXT,
          parent_id TEXT,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'pending_validation', 'validation_failed')),
          priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
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
          validation_report TEXT,
          validated_by TEXT,
          validation_count INTEGER DEFAULT 0,
          FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
          FOREIGN KEY (parent_id) REFERENCES todos(id) ON DELETE CASCADE
        );
        INSERT INTO todos_new (
          id, agent_id, project_id, parent_id, title, description, status, priority,
          context, tags, dependencies, acceptance_criteria, criteria_confirmed,
          max_attempts, attempt_count, attempt_log, last_heartbeat,
          heartbeat_progress, heartbeat_step, heartbeat_blockers, position,
          created_at, updated_at, completed_at, expected_duration_minutes,
          schedule, is_template, origin_agent_id, assigned_agent_id,
          assignment_note, assigned_at, transferred_from, archived,
          next_due_at, last_spawned_at, last_driven_at,
          validation_report, validated_by, validation_count
        )
        SELECT 
          id, agent_id, project_id, parent_id, title, description, status, priority,
          context, tags, dependencies, acceptance_criteria, criteria_confirmed,
          max_attempts, attempt_count, attempt_log, last_heartbeat,
          heartbeat_progress, heartbeat_step, heartbeat_blockers, position,
          created_at, updated_at, completed_at, expected_duration_minutes,
          schedule, is_template, origin_agent_id, assigned_agent_id,
          assignment_note, assigned_at, transferred_from, archived,
          next_due_at, last_spawned_at, last_driven_at,
          validation_report, validated_by, validation_count
        FROM todos;
        DROP TABLE todos;
        ALTER TABLE todos_new RENAME TO todos;
        CREATE INDEX IF NOT EXISTS idx_todos_agent_id ON todos(agent_id);
        CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id);
        CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
        CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
        CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at);
        CREATE INDEX IF NOT EXISTS idx_todos_parent_id ON todos(parent_id);
        CREATE INDEX IF NOT EXISTS idx_todos_template_due ON todos(is_template, next_due_at);
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
      console.log('[DB] Migration: todos status CHECK constraint updated');
    }
  } catch (err) {
    console.log('[DB] Migration: todos status CHECK constraint failed:', err.message);
  }
}

module.exports = { getDb };
