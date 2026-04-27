const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

class Project {
  static create(agentId, data) {
    const db = getDb();
    const id = uuidv4();
    const { name, description = '', color = '#667eea' } = data;

    const stmt = db.prepare(`
      INSERT INTO projects (id, agent_id, name, description, color)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(id, agentId, name, description, color);

    return this.findById(agentId, id);
  }

  static findById(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM projects WHERE id = ? AND agent_id = ?');
    return stmt.get(id, agentId);
  }

  static findAllByAgent(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT p.*, 
             (SELECT COUNT(*) FROM todos WHERE project_id = p.id) as todo_count,
             (SELECT COUNT(*) FROM todos WHERE project_id = p.id AND status = 'completed') as completed_count
      FROM projects p
      WHERE p.agent_id = ?
      ORDER BY p.created_at DESC
    `);
    return stmt.all(agentId);
  }

  static update(agentId, id, data) {
    const db = getDb();
    const { name, description, color } = data;

    const updates = [];
    const values = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (color !== undefined) {
      updates.push('color = ?');
      values.push(color);
    }

    if (updates.length === 0) {
      return this.findById(agentId, id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, agentId);

    const stmt = db.prepare(`
      UPDATE projects SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);

    stmt.run(...values);

    return this.findById(agentId, id);
  }

  static delete(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM projects WHERE id = ? AND agent_id = ?');
    const result = stmt.run(id, agentId);

    return result.changes > 0;
  }

  static exists(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('SELECT 1 FROM projects WHERE id = ? AND agent_id = ?');
    return stmt.get(id, agentId) !== undefined;
  }
}

module.exports = Project;
