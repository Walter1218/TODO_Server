const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

class Agent {
  static create(data) {
    const db = getDb();
    const id = data.id || uuidv4();
    const { name, metadata = {} } = data;
    const secret_key = require('crypto').randomBytes(16).toString('hex').toUpperCase();

    const stmt = db.prepare(`
      INSERT INTO agents (id, name, metadata, secret_key)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(id, name, JSON.stringify(metadata), secret_key);

    // Return with secret_key ONCE on creation
    return this.findById(id, true);
  }

  static getSecretKey(agentId) {
    const db = getDb();
    const stmt = db.prepare('SELECT secret_key FROM agents WHERE id = ?');
    const row = stmt.get(agentId);
    return row ? row.secret_key : null;
  }

  static findById(id, includeSecret = false) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM agents WHERE id = ?');
    const agent = stmt.get(id);

    if (agent) {
      agent.metadata = JSON.parse(agent.metadata || '{}');
      if (!includeSecret) {
        delete agent.secret_key;
      }
    }

    return agent;
  }

  static findAll() {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM agents ORDER BY created_at DESC');
    const agents = stmt.all();

    return agents.map(agent => ({
      ...agent,
      metadata: JSON.parse(agent.metadata || '{}')
    }));
  }

  static update(id, data) {
    const db = getDb();
    const { name, metadata, maxConcurrentTasks } = data;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }

    if (metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(JSON.stringify(metadata));
    }

    if (maxConcurrentTasks !== undefined) {
      updates.push('max_concurrent_tasks = ?');
      values.push(maxConcurrentTasks);
    }

    if (updates.length === 0) {
      return this.findById(id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE agents SET ${updates.join(', ')} WHERE id = ?
    `);

    stmt.run(...values);

    return this.findById(id);
  }

  static delete(id) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM agents WHERE id = ?');
    const result = stmt.run(id);

    return result.changes > 0;
  }

  static exists(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT 1 FROM agents WHERE id = ?');
    return stmt.get(id) !== undefined;
  }

  static getMaxConcurrent(agentId) {
    const db = getDb();
    const row = db.prepare('SELECT max_concurrent_tasks FROM agents WHERE id = ?').get(agentId);
    return row ? (row.max_concurrent_tasks || 5) : 5;
  }

  static getActiveTaskCount(agentId) {
    const db = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM todos
      WHERE agent_id = ? AND status IN ('in_progress', 'validating', 'pending_validation')
        AND (is_template = 0 OR is_template IS NULL)
        AND (archived = 0 OR archived IS NULL)
    `).get(agentId);
    return row ? row.cnt : 0;
  }

  static canAcceptNewTask(agentId) {
    const active = this.getActiveTaskCount(agentId);
    const max = this.getMaxConcurrent(agentId);
    return { active, max, canAccept: active < max };
  }
}

module.exports = Agent;
