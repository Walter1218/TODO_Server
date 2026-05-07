const { getDb } = require('../db');

function toSqliteTimestamp(date) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

class OpsMetricsService {
  static getAgentMetrics(agentId, options = {}) {
    const db = getDb();
    const hours = Math.max(1, Number.parseInt(options.hours, 10) || 24);
    const since = toSqliteTimestamp(Date.now() - hours * 60 * 60 * 1000);

    const runStats = db.prepare(`
      SELECT
        COUNT(*) as spawned_jobs,
        SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) as started_jobs,
        SUM(CASE WHEN first_heartbeat_at IS NOT NULL THEN 1 ELSE 0 END) as first_heartbeat_jobs,
        SUM(CASE WHEN final_status = 'completed' THEN 1 ELSE 0 END) as completed_jobs,
        SUM(CASE WHEN final_status = 'pending_validation' THEN 1 ELSE 0 END) as pending_validation_jobs,
        SUM(CASE WHEN pending_validation_at IS NOT NULL THEN 1 ELSE 0 END) as entered_validation_jobs,
        SUM(CASE WHEN validated_at IS NOT NULL AND final_status = 'completed' THEN 1 ELSE 0 END) as validation_passed_jobs,
        SUM(CASE WHEN failure_bucket = 'validation_failed' OR final_status = 'validation_failed' THEN 1 ELSE 0 END) as validation_failed_jobs,
        SUM(CASE WHEN final_status = 'blocked' THEN 1 ELSE 0 END) as blocked_jobs
      FROM job_runs
      WHERE agent_id = ? AND spawned_at >= ?
    `).get(agentId, since);

    const failureBuckets = db.prepare(`
      SELECT COALESCE(failure_bucket, 'none') as bucket, COUNT(*) as count
      FROM job_runs
      WHERE agent_id = ? AND spawned_at >= ?
      GROUP BY COALESCE(failure_bucket, 'none')
      ORDER BY count DESC, bucket ASC
    `).all(agentId, since);

    const schedulerEvents = db.prepare(`
      SELECT event_type, COUNT(*) as count
      FROM scheduler_events
      WHERE agent_id = ? AND created_at >= ?
      GROUP BY event_type
      ORDER BY count DESC, event_type ASC
    `).all(agentId, since);

    const spawned = runStats.spawned_jobs || 0;
    const enteredValidation = runStats.entered_validation_jobs || 0;

    const ratio = (numerator, denominator) => (
      denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0
    );

    return {
      window: {
        hours,
        since
      },
      counts: {
        spawned_jobs: spawned,
        started_jobs: runStats.started_jobs || 0,
        first_heartbeat_jobs: runStats.first_heartbeat_jobs || 0,
        completed_jobs: runStats.completed_jobs || 0,
        pending_validation_jobs: runStats.pending_validation_jobs || 0,
        entered_validation_jobs: enteredValidation,
        validation_passed_jobs: runStats.validation_passed_jobs || 0,
        validation_failed_jobs: runStats.validation_failed_jobs || 0,
        blocked_jobs: runStats.blocked_jobs || 0
      },
      ratios: {
        startup_rate: ratio(runStats.started_jobs || 0, spawned),
        first_heartbeat_rate: ratio(runStats.first_heartbeat_jobs || 0, spawned),
        completion_rate: ratio(runStats.completed_jobs || 0, spawned),
        validation_pass_rate: ratio(runStats.validation_passed_jobs || 0, enteredValidation),
        blocked_rate: ratio(runStats.blocked_jobs || 0, spawned)
      },
      failure_buckets: failureBuckets.map(item => ({
        bucket: item.bucket,
        count: item.count
      })),
      scheduler_events: schedulerEvents.map(item => ({
        event_type: item.event_type,
        count: item.count
      }))
    };
  }
}

module.exports = OpsMetricsService;
