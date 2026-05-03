const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

class Notification {
  static create(agentId, taskId, type, message) {
    const db = getDb();
    const id = uuidv4();
    const stmt = db.prepare(`
      INSERT INTO task_notifications (id, agent_id, task_id, type, message)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, agentId, taskId, type, message);
    return this.findById(id);
  }

  static findById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM task_notifications WHERE id = ?');
    return stmt.get(id);
  }

  static findByAgent(agentId, options = {}) {
    const db = getDb();
    const { unreadOnly = false, limit = 50 } = options;

    let query = 'SELECT * FROM task_notifications WHERE agent_id = ?';
    const params = [agentId];

    if (unreadOnly) {
      query += ' AND read = false';
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const stmt = db.prepare(query);
    return stmt.all(...params);
  }

  static findByTask(agentId, taskId, limit = 50) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM task_notifications 
      WHERE agent_id = ? AND task_id = ?
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    return stmt.all(agentId, taskId, limit);
  }

  static markAsRead(id) {
    const db = getDb();
    const stmt = db.prepare('UPDATE task_notifications SET read = true WHERE id = ?');
    stmt.run(id);
    return this.findById(id);
  }

  static markAllAsRead(agentId) {
    const db = getDb();
    const stmt = db.prepare('UPDATE task_notifications SET read = true WHERE agent_id = ?');
    const result = stmt.run(agentId);
    return result.changes;
  }

  static getUnreadCount(agentId) {
    const db = getDb();
    const stmt = db.prepare('SELECT COUNT(*) as count FROM task_notifications WHERE agent_id = ? AND read = false');
    return stmt.get(agentId).count;
  }
}

module.exports = Notification;
