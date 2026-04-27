const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'todo.db');

let db;

function getDb() {
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
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
      context TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      dependencies TEXT DEFAULT '[]',
      position INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_todos_agent_id ON todos(agent_id);
    CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id);
    CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
    CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
    CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at);
    CREATE INDEX IF NOT EXISTS idx_projects_agent_id ON projects(agent_id);
  `);
}

module.exports = { getDb };
