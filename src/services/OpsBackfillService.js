const { getDb } = require('../db');
const JobRunService = require('./JobRunService');
const Todo = require('../models/Todo');

const ACTIVE_STATUSES = ['pending', 'in_progress', 'blocked', 'failed', 'pending_validation', 'validating', 'validation_failed'];
const PENDING_GRACE_MINUTES = 30;
const HEARTBEAT_GRACE_MINUTES = 15;

function parseDbTime(value) {
  if (!value) return 0;
  const normalized = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const ts = Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  return Number.isFinite(ts) ? ts : 0;
}

class OpsBackfillService {
  static classifyTask(task, nowMs = Date.now()) {
    if (!task || task.is_template || task.archived) return null;

    const createdAt = parseDbTime(task.created_at);
    const updatedAt = parseDbTime(task.updated_at);
    const lastHeartbeat = parseDbTime(task.last_heartbeat);
    const pendingAgeMs = createdAt ? nowMs - createdAt : 0;
    const idleMs = lastHeartbeat ? nowMs - lastHeartbeat : (updatedAt ? nowMs - updatedAt : pendingAgeMs);

    if (task.status === 'validation_failed') return 'validation_failed';

    if (task.status === 'pending') {
      if (!lastHeartbeat && pendingAgeMs >= PENDING_GRACE_MINUTES * 60 * 1000) {
        return 'not_started';
      }
      return null;
    }

    if (['in_progress', 'pending_validation', 'validating', 'blocked', 'failed'].includes(task.status)) {
      if (!lastHeartbeat || idleMs >= HEARTBEAT_GRACE_MINUTES * 60 * 1000) {
        return 'no_heartbeat';
      }
    }

    return null;
  }

  static backfillActiveRuns(options = {}) {
    const db = getDb();
    const hours = Number.isFinite(options.hours) ? options.hours : 24;
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - hours * 60 * 60 * 1000).toISOString();

    const tasks = db.prepare(`
      SELECT *
      FROM todos
      WHERE (archived = 0 OR archived IS NULL)
        AND (is_template = 0 OR is_template IS NULL)
        AND (
          created_at >= ?
          OR status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})
        )
    `).all(cutoff, ...ACTIVE_STATUSES);

    let runsCreated = 0;
    let bucketsAssigned = 0;

    for (const task of tasks) {
      const existingRun = JobRunService.getRunByTaskId(task.agent_id, task.id);
      if (!existingRun) {
        JobRunService.ensureRun(task.agent_id, task, {
          plannedAt: task.created_at || undefined,
          spawnedAt: task.created_at || undefined,
          failureBucket: task.failure_bucket || undefined
        });
        runsCreated += 1;
      }

      const run = JobRunService.getRunByTaskId(task.agent_id, task.id);
      const patch = {
        finalStatus: task.status,
        metadata: { source: 'ops_backfill' }
      };

      if (!run?.started_at && ['in_progress', 'blocked', 'failed', 'pending_validation', 'validating', 'validation_failed', 'completed'].includes(task.status)) {
        patch.startedAt = task.last_heartbeat || task.updated_at || task.created_at;
      }
      if (!run?.first_heartbeat_at && task.last_heartbeat) {
        patch.firstHeartbeatAt = task.last_heartbeat;
      }
      if (!run?.pending_validation_at && ['pending_validation', 'validating', 'validation_failed', 'completed'].includes(task.status)) {
        patch.pendingValidationAt = task.updated_at || task.last_heartbeat || task.created_at;
      }
      if (!run?.completed_at && task.status === 'completed') {
        patch.completedAt = task.completed_at || task.updated_at || task.created_at;
      }
      if (!run?.validated_at && ['validation_failed'].includes(task.status)) {
        patch.validatedAt = task.updated_at || task.created_at;
      }

      JobRunService.upsertRun(task.agent_id, task, patch);

      const inferredBucket = this.classifyTask(task, nowMs);
      if (inferredBucket && !task.failure_bucket) {
        Todo.update(task.agent_id, task.id, { failureBucket: inferredBucket });
        JobRunService.setTaskFailureBucket(task.agent_id, task.id, inferredBucket);
        bucketsAssigned += 1;
      }
    }

    return {
      scannedTasks: tasks.length,
      runsCreated,
      bucketsAssigned
    };
  }

  static reconcileAutoHealingTasks() {
    const db = getDb();
    const rows = db.prepare(`
      SELECT c.id AS child_id, c.agent_id, c.title AS child_title, c.status AS child_status,
             p.id AS parent_id, p.title AS parent_title, p.status AS parent_status
      FROM todos c
      JOIN todos p ON p.id = c.parent_id AND p.agent_id = c.agent_id
      WHERE (c.archived = 0 OR c.archived IS NULL)
        AND (c.is_template = 0 OR c.is_template IS NULL)
        AND c.title LIKE '[修复] 自动修复任务 for %'
        AND c.status IN ('pending', 'in_progress', 'blocked', 'failed')
        AND p.status IN ('completed', 'cancelled')
    `).all();

    let cancelledChildren = 0;

    for (const row of rows) {
      Todo.update(row.agent_id, row.child_id, {
        status: 'cancelled',
        failureBucket: null,
        heartbeatStep: row.parent_status === 'completed'
          ? `🧹 父任务已完成，自动修复子任务自动取消（${row.parent_title}）`
          : `🧹 父任务已取消，自动修复子任务自动取消（${row.parent_title}）`
      });
      JobRunService.clearTaskFailureBucket(row.agent_id, row.child_id);
      cancelledChildren += 1;
    }

    return { cancelledChildren };
  }
}

module.exports = OpsBackfillService;
