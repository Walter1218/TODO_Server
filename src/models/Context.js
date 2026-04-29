const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

class Context {
  static create(agentId, data) {
    const db = getDb();
    const id = uuidv4();
    const {
      sessionId,
      role,
      content,
      metadata = {}
    } = data;

    const stmt = db.prepare(`
      INSERT INTO contexts (id, agent_id, session_id, role, content, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, agentId, sessionId, role, content, JSON.stringify(metadata));
    return this.findById(agentId, id);
  }

  static findById(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM contexts WHERE id = ? AND agent_id = ?');
    const ctx = stmt.get(id, agentId);
    if (ctx) {
      ctx.metadata = JSON.parse(ctx.metadata || '{}');
    }
    return ctx;
  }

  static findBySession(agentId, sessionId, limit = 100) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM contexts
      WHERE agent_id = ? AND session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `);
    const contexts = stmt.all(agentId, sessionId, limit);
    return contexts.map(ctx => ({
      ...ctx,
      metadata: JSON.parse(ctx.metadata || '{}')
    }));
  }

  static findRecentByAgent(agentId, limit = 50) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM contexts
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const contexts = stmt.all(agentId, limit);
    return contexts.map(ctx => ({
      ...ctx,
      metadata: JSON.parse(ctx.metadata || '{}')
    })).reverse(); // Return in chronological order
  }

  static getSessionSummary(agentId, sessionId) {
    const db = getDb();

    // Get message count
    const countStmt = db.prepare(`
      SELECT COUNT(*) as count FROM contexts
      WHERE agent_id = ? AND session_id = ?
    `);
    const { count } = countStmt.get(agentId, sessionId);

    // Get first and last message time
    const timeStmt = db.prepare(`
      SELECT MIN(created_at) as started_at, MAX(created_at) as last_at
      FROM contexts
      WHERE agent_id = ? AND session_id = ?
    `);
    const times = timeStmt.get(agentId, sessionId);

    // Get recent messages for summary
    const recentStmt = db.prepare(`
      SELECT role, content, created_at FROM contexts
      WHERE agent_id = ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const recent = recentStmt.all(agentId, sessionId);

    return {
      agent_id: agentId,
      session_id: sessionId,
      message_count: count,
      started_at: times.started_at,
      last_at: times.last_at,
      recent_messages: recent.reverse().map(m => ({
        role: m.role,
        content: m.content.substring(0, 200) + (m.content.length > 200 ? '...' : ''),
        created_at: m.created_at
      }))
    };
  }

  static deleteBySession(agentId, sessionId) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM contexts WHERE agent_id = ? AND session_id = ?');
    const result = stmt.run(agentId, sessionId);
    return result.changes;
  }

  static pruneOldContexts(agentId, maxAgeDays = 30) {
    const db = getDb();
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString();
    const stmt = db.prepare('DELETE FROM contexts WHERE agent_id = ? AND created_at < ?');
    const result = stmt.run(agentId, cutoff);
    return result.changes;
  }
}

module.exports = Context;
