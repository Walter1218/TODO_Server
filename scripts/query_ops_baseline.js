const { getDb } = require('../src/db');
const OpsBackfillService = require('../src/services/OpsBackfillService');
function ratio(num, den) {
  return den > 0 ? Number((num / den).toFixed(4)) : 0;
}

function readGlobal24h(db) {
  return db.prepare(`
    SELECT
      COUNT(1) AS spawned_jobs,
      SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS started_jobs,
      SUM(CASE WHEN first_heartbeat_at IS NOT NULL THEN 1 ELSE 0 END) AS first_heartbeat_jobs,
      SUM(CASE WHEN final_status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
      SUM(CASE WHEN pending_validation_at IS NOT NULL THEN 1 ELSE 0 END) AS entered_validation_jobs,
      SUM(CASE WHEN validated_at IS NOT NULL AND final_status = 'completed' THEN 1 ELSE 0 END) AS validation_passed_jobs,
      SUM(CASE WHEN final_status = 'blocked' THEN 1 ELSE 0 END) AS blocked_jobs
    FROM job_runs
    WHERE spawned_at >= datetime('now', '-24 hours')
  `).get();
}

function readFailureBuckets(db, whereClause = '', params = []) {
  return db.prepare(`
    SELECT COALESCE(failure_bucket, 'none') AS bucket, COUNT(1) AS count
    FROM job_runs
    ${whereClause}
    GROUP BY COALESCE(failure_bucket, 'none')
    ORDER BY count DESC, bucket ASC
  `).all(...params);
}

function readTopAgents24h(db) {
  return db.prepare(`
    SELECT agent_id, COUNT(1) AS cnt
    FROM job_runs
    WHERE spawned_at >= datetime('now', '-24 hours')
    GROUP BY agent_id
    ORDER BY cnt DESC, agent_id ASC
  `).all();
}

function readAgentMetrics24h(db, agentId) {
  const row = db.prepare(`
    SELECT
      COUNT(1) AS spawned_jobs,
      SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS started_jobs,
      SUM(CASE WHEN first_heartbeat_at IS NOT NULL THEN 1 ELSE 0 END) AS first_heartbeat_jobs,
      SUM(CASE WHEN final_status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
      SUM(CASE WHEN pending_validation_at IS NOT NULL THEN 1 ELSE 0 END) AS entered_validation_jobs,
      SUM(CASE WHEN validated_at IS NOT NULL AND final_status = 'completed' THEN 1 ELSE 0 END) AS validation_passed_jobs,
      SUM(CASE WHEN final_status = 'blocked' THEN 1 ELSE 0 END) AS blocked_jobs
    FROM job_runs
    WHERE agent_id = ? AND spawned_at >= datetime('now', '-24 hours')
  `).get(agentId);

  const buckets = db.prepare(`
    SELECT COALESCE(failure_bucket, 'none') AS bucket, COUNT(1) AS count
    FROM job_runs
    WHERE agent_id = ? AND spawned_at >= datetime('now', '-24 hours')
    GROUP BY COALESCE(failure_bucket, 'none')
    ORDER BY count DESC, bucket ASC
  `).all(agentId);

  return {
    counts: row,
    ratios: {
      startup_rate: ratio(row.started_jobs || 0, row.spawned_jobs || 0),
      first_heartbeat_rate: ratio(row.first_heartbeat_jobs || 0, row.spawned_jobs || 0),
      completion_rate: ratio(row.completed_jobs || 0, row.spawned_jobs || 0),
      validation_pass_rate: ratio(row.validation_passed_jobs || 0, row.entered_validation_jobs || 0),
      blocked_rate: ratio(row.blocked_jobs || 0, row.spawned_jobs || 0)
    },
    failure_buckets: buckets
  };
}

function readWindow(db) {
  return db.prepare(`
    SELECT
      MIN(spawned_at) AS min_spawned_at,
      MAX(spawned_at) AS max_spawned_at,
      COUNT(1) AS total_runs
    FROM job_runs
  `).get();
}

function readTodoFailureBuckets(db) {
  return db.prepare(`
    SELECT COALESCE(failure_bucket, 'none') AS bucket, COUNT(1) AS count
    FROM todos
    WHERE archived = 0
      AND is_template = 0
      AND status IN ('blocked', 'validation_failed', 'failed', 'in_progress', 'pending_validation', 'pending')
    GROUP BY COALESCE(failure_bucket, 'none')
    ORDER BY count DESC, bucket ASC
  `).all();
}

function readTodoStatusBreakdown(db) {
  return db.prepare(`
    SELECT status, COUNT(1) AS count
    FROM todos
    WHERE archived = 0
      AND is_template = 0
    GROUP BY status
    ORDER BY count DESC, status ASC
  `).all();
}

function main() {
  const backfill = OpsBackfillService.backfillActiveRuns({ hours: 24 });
  const db = getDb();
  const global24h = readGlobal24h(db);
  const topAgents24h = readTopAgents24h(db);
  const buckets24h = readFailureBuckets(db, `WHERE spawned_at >= datetime('now', '-24 hours')`);
  const bucketsAll = readFailureBuckets(db);
  const window = readWindow(db);
  const todoFailureBuckets = readTodoFailureBuckets(db);
  const todoStatusBreakdown = readTodoStatusBreakdown(db);

  const baseline = {
    global24h: {
      ...global24h,
      startup_rate: ratio(global24h.started_jobs || 0, global24h.spawned_jobs || 0),
      first_heartbeat_rate: ratio(global24h.first_heartbeat_jobs || 0, global24h.spawned_jobs || 0),
      completion_rate: ratio(global24h.completed_jobs || 0, global24h.spawned_jobs || 0),
      validation_pass_rate: ratio(global24h.validation_passed_jobs || 0, global24h.entered_validation_jobs || 0),
      blocked_rate: ratio(global24h.blocked_jobs || 0, global24h.spawned_jobs || 0)
    },
    backfill,
    topAgents24h,
    failureBuckets24h: buckets24h,
    failureBucketsAll: bucketsAll,
    todoFailureBuckets,
    todoStatusBreakdown,
    window,
    perAgent24h: topAgents24h.map(row => ({
      agent_id: row.agent_id,
      metrics: readAgentMetrics24h(db, row.agent_id)
    }))
  };

  console.log(JSON.stringify(baseline, null, 2));
}

main();
