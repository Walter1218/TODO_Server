const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');

const FAILURE_BUCKETS = new Set([
  'not_started',
  'no_heartbeat',
  'tool_failure',
  'env_missing',
  'llm_unstable',
  'validation_failed',
  'human_blocked'
]);

function normalizeFailureBucket(bucket) {
  if (bucket === null) return null;
  if (bucket === undefined) return undefined;
  const normalized = String(bucket || '').trim();
  if (!normalized) return null;
  return FAILURE_BUCKETS.has(normalized) ? normalized : null;
}

function stringifyDetails(details = {}) {
  try {
    return JSON.stringify(details || {});
  } catch (err) {
    return JSON.stringify({ error: `details_stringify_failed:${err.message}` });
  }
}

class JobRunService {
  static getRunByTaskId(agentId, taskId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM job_runs
      WHERE agent_id = ? AND task_id = ?
      LIMIT 1
    `).get(agentId, taskId);
  }

  static ensureRun(agentId, task, options = {}) {
    if (!task || task.is_template) return null;

    const existing = this.getRunByTaskId(agentId, task.id);
    if (existing) return existing;

    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO job_runs (
        id, agent_id, task_id, template_id, planned_at, spawned_at, final_status, failure_bucket, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      agentId,
      task.id,
      options.templateId !== undefined ? options.templateId : (task.parent_id || null),
      options.plannedAt || task.created_at || new Date().toISOString(),
      options.spawnedAt || task.created_at || new Date().toISOString(),
      task.status || 'pending',
      normalizeFailureBucket(options.failureBucket !== undefined ? options.failureBucket : task.failure_bucket),
      stringifyDetails(options.metadata || {})
    );

    return this.getRunByTaskId(agentId, task.id);
  }

  static upsertRun(agentId, task, patch = {}) {
    if (!task || task.is_template) return null;
    const existing = this.ensureRun(agentId, task, patch);
    if (!existing) return null;

    const db = getDb();
    const updates = [];
    const values = [];

    const pushField = (field, value) => {
      if (value === undefined) return;
      updates.push(`${field} = ?`);
      values.push(value);
    };

    pushField('template_id', patch.templateId !== undefined ? patch.templateId : (task.parent_id || existing.template_id || null));
    pushField('planned_at', patch.plannedAt);
    pushField('spawned_at', patch.spawnedAt);
    pushField('started_at', patch.startedAt);
    pushField('first_heartbeat_at', patch.firstHeartbeatAt);
    pushField('pending_validation_at', patch.pendingValidationAt);
    pushField('completed_at', patch.completedAt);
    pushField('validated_at', patch.validatedAt);
    pushField('final_status', patch.finalStatus !== undefined ? patch.finalStatus : task.status);

    const failureBucket = normalizeFailureBucket(
      patch.failureBucket !== undefined ? patch.failureBucket : task.failure_bucket
    );
    if (failureBucket !== undefined) {
      updates.push('failure_bucket = ?');
      values.push(failureBucket);
    }

    if (patch.metadata !== undefined) {
      updates.push('metadata = ?');
      values.push(stringifyDetails(patch.metadata));
    }

    if (updates.length === 0) {
      return this.getRunByTaskId(agentId, task.id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(existing.id);

    db.prepare(`
      UPDATE job_runs
      SET ${updates.join(', ')}
      WHERE id = ?
    `).run(...values);

    return this.getRunByTaskId(agentId, task.id);
  }

  static appendSchedulerEvent(agentId, eventType, payload = {}) {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO scheduler_events (
        id, agent_id, template_id, task_id, event_type, event_status, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      agentId,
      payload.templateId || null,
      payload.taskId || null,
      eventType,
      payload.eventStatus || 'info',
      stringifyDetails(payload.details || {})
    );
    return id;
  }

  static markSpawned(agentId, task, options = {}) {
    if (!task || task.is_template) return null;
    const run = this.upsertRun(agentId, task, {
      templateId: options.templateId !== undefined ? options.templateId : (task.parent_id || null),
      plannedAt: options.plannedAt,
      spawnedAt: options.spawnedAt || task.created_at || new Date().toISOString(),
      finalStatus: task.status || 'pending',
      failureBucket: null,
      metadata: options.metadata || {}
    });
    this.appendSchedulerEvent(agentId, 'task_spawned', {
      templateId: options.templateId !== undefined ? options.templateId : (task.parent_id || null),
      taskId: task.id,
      eventStatus: 'success',
      details: options.metadata || {}
    });
    return run;
  }

  static markDriveStarted(agentId, task, details = {}) {
    if (!task || task.is_template) return null;
    const existing = this.ensureRun(agentId, task, details);
    const startedAt = existing && existing.started_at ? undefined : (details.startedAt || new Date().toISOString());
    return this.upsertRun(agentId, task, {
      startedAt,
      finalStatus: 'in_progress',
      failureBucket: null,
      metadata: details
    });
  }

  static markHeartbeat(agentId, task, details = {}) {
    if (!task || task.is_template) return null;
    const existing = this.ensureRun(agentId, task, details);
    const firstHeartbeatAt = existing && existing.first_heartbeat_at
      ? undefined
      : (details.firstHeartbeatAt || new Date().toISOString());
    return this.upsertRun(agentId, task, {
      firstHeartbeatAt,
      finalStatus: task.status || existing.final_status,
      metadata: details
    });
  }

  static markPendingValidation(agentId, task, details = {}) {
    if (!task || task.is_template) return null;
    return this.upsertRun(agentId, task, {
      pendingValidationAt: details.pendingValidationAt || new Date().toISOString(),
      finalStatus: 'pending_validation',
      failureBucket: null,
      metadata: details
    });
  }

  static markCompleted(agentId, task, details = {}) {
    if (!task || task.is_template) return null;
    return this.upsertRun(agentId, task, {
      completedAt: details.completedAt || task.completed_at || new Date().toISOString(),
      finalStatus: 'completed',
      failureBucket: null,
      metadata: details
    });
  }

  static markValidated(agentId, task, pass, details = {}) {
    if (!task || task.is_template) return null;
    return this.upsertRun(agentId, task, {
      validatedAt: details.validatedAt || new Date().toISOString(),
      finalStatus: pass ? 'completed' : 'validation_failed',
      failureBucket: pass ? null : 'validation_failed',
      metadata: details
    });
  }

  static markFailure(agentId, task, bucket, details = {}) {
    if (!task || task.is_template) return null;
    return this.upsertRun(agentId, task, {
      finalStatus: task.status,
      failureBucket: normalizeFailureBucket(bucket),
      metadata: details
    });
  }

  static setTaskFailureBucket(agentId, taskId, bucket) {
    const normalized = normalizeFailureBucket(bucket);
    const db = getDb();
    db.prepare(`
      UPDATE todos
      SET failure_bucket = ?, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ? AND id = ?
    `).run(normalized, agentId, taskId);

    const task = db.prepare(`
      SELECT id, agent_id, parent_id, is_template, status, failure_bucket, completed_at, created_at
      FROM todos
      WHERE agent_id = ? AND id = ?
      LIMIT 1
    `).get(agentId, taskId);
    if (task && !task.is_template) {
      this.upsertRun(agentId, task, {
        failureBucket: normalized,
        finalStatus: task.status
      });
    }
  }

  static clearTaskFailureBucket(agentId, taskId) {
    this.setTaskFailureBucket(agentId, taskId, null);
  }

  static syncTaskState(agentId, task, previousTask = null, details = {}) {
    if (!task || task.is_template) return null;

    const previousStatus = previousTask ? previousTask.status : null;
    const currentStatus = task.status;
    this.ensureRun(agentId, task, details);

    if (currentStatus === 'in_progress') {
      this.markDriveStarted(agentId, task, details);
      this.clearTaskFailureBucket(agentId, task.id);
      return;
    }

    if (currentStatus === 'pending_validation') {
      this.markPendingValidation(agentId, task, details);
      this.clearTaskFailureBucket(agentId, task.id);
      return;
    }

    if (currentStatus === 'completed') {
      if (previousStatus && ['pending_validation', 'validating', 'validation_failed'].includes(previousStatus)) {
        this.markValidated(agentId, task, true, details);
      } else {
        this.markCompleted(agentId, task, details);
      }
      this.clearTaskFailureBucket(agentId, task.id);
      return;
    }

    if (currentStatus === 'validation_failed') {
      this.setTaskFailureBucket(agentId, task.id, 'validation_failed');
      this.markValidated(agentId, task, false, details);
      return;
    }

    if (currentStatus === 'blocked' || currentStatus === 'failed') {
      const bucket = normalizeFailureBucket(task.failure_bucket) || normalizeFailureBucket(details.failureBucket) || 'tool_failure';
      this.setTaskFailureBucket(agentId, task.id, bucket);
      this.markFailure(agentId, task, bucket, details);
      return;
    }

    if (currentStatus === 'pending' && previousStatus && previousStatus !== 'pending') {
      this.clearTaskFailureBucket(agentId, task.id);
      this.upsertRun(agentId, task, { finalStatus: 'pending', metadata: details });
      return;
    }

    this.upsertRun(agentId, task, {
      finalStatus: currentStatus,
      failureBucket: task.failure_bucket,
      metadata: details
    });
  }
}

module.exports = JobRunService;
