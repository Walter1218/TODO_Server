const db = require('../src/db').getDb();
const TaskReportService = require('../src/services/TaskReportService');

async function main() {
  const tasks = db.prepare(`
    SELECT id, parent_id, title, status, priority, failure_bucket, assigned_agent_id,
           heartbeat_progress, heartbeat_step, last_heartbeat, created_at, updated_at,
           completed_at, completion_report, validation_report, attempt_log
    FROM todos
    WHERE agent_id = 'hermes-default'
      AND archived = 0
      AND is_template = 0
      AND status = 'in_progress'
    ORDER BY created_at ASC
  `).all();

  const output = [];
  for (const task of tasks) {
    const report = await TaskReportService.generateReport('hermes-default', task.id);
    let attempts = [];
    try {
      attempts = JSON.parse(task.attempt_log || '[]');
    } catch (_) {}

    output.push({
      id: task.id,
      parent_id: task.parent_id,
      title: task.title,
      priority: task.priority,
      failure_bucket: task.failure_bucket,
      heartbeat_progress: task.heartbeat_progress,
      heartbeat_step: task.heartbeat_step,
      last_heartbeat: task.last_heartbeat,
      created_at: task.created_at,
      updated_at: task.updated_at,
      completed_at: task.completed_at,
      has_completion_report: Boolean(task.completion_report),
      has_validation_report: Boolean(task.validation_report),
      attempt_log_size: attempts.length,
      execution: report.execution ? {
        status: report.execution.status,
        attempt_count: report.execution.attempt_count,
        blockers: report.execution.blockers || [],
        key_outputs: report.execution.key_outputs || []
      } : null,
      validation: report.validation ? {
        status: report.validation.status,
        verdict: report.validation.verdict,
        reason: report.validation.reason || ''
      } : null,
      timeline_tail: (report.timeline || []).slice(-5)
    });
  }

  console.log(JSON.stringify(output, null, 2));
}

main();
