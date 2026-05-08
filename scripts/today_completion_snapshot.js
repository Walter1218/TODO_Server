const { getDb } = require('../src/db');

const db = getDb();
const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const agentId = process.argv[3] || 'hermes-default';

const rows = db.prepare(
  "SELECT status, COUNT(*) AS c FROM todos WHERE agent_id = ? AND is_template = 0 AND (archived = 0 OR archived IS NULL) AND substr(created_at, 1, 10) = ? GROUP BY status ORDER BY status"
).all(agentId, day);

const total = rows.reduce((sum, row) => sum + row.c, 0);
const completed = (rows.find(row => row.status === 'completed') || { c: 0 }).c;
const validationPassedCompleted = db.prepare(
  "SELECT COUNT(*) AS c FROM todos WHERE agent_id = ? AND is_template = 0 AND (archived = 0 OR archived IS NULL) AND substr(created_at, 1, 10) = ? AND status = 'completed' AND validation_report IS NOT NULL"
).get(agentId, day).c;

const unfinished = db.prepare(
  "SELECT id, title, status, created_at, heartbeat_step FROM todos WHERE agent_id = ? AND is_template = 0 AND (archived = 0 OR archived IS NULL) AND substr(created_at, 1, 10) = ? AND status NOT IN ('completed', 'cancelled') ORDER BY datetime(created_at) ASC"
).all(agentId, day);

console.log(JSON.stringify({
  agent_id: agentId,
  day,
  rows,
  total,
  completed,
  completion_rate: total ? Number((completed / total).toFixed(4)) : 0,
  validation_passed_completed: validationPassedCompleted,
  unfinished_count: unfinished.length,
  unfinished: unfinished.slice(0, 100)
}, null, 2));
