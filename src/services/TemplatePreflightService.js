const CommandExecutor = require('./CommandExecutor');
const JobRunService = require('./JobRunService');
const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const { getDb } = require('../db');

function safeJsonParse(text, fallback = {}) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

class TemplatePreflightService {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || parseInt(process.env.TEMPLATE_CIRCUIT_FAILURE_THRESHOLD || '3', 10);
    this.cooldownMinutes = options.cooldownMinutes || parseInt(process.env.TEMPLATE_CIRCUIT_OPEN_MINUTES || '120', 10);
  }

  _calculateFailureStreak(agentId, templateId) {
    const db = getDb();
    const recentRuns = db.prepare(`
      SELECT final_status, failure_bucket
      FROM job_runs
      WHERE agent_id = ? AND template_id = ?
      ORDER BY COALESCE(spawned_at, created_at) DESC, created_at DESC
      LIMIT 20
    `).all(agentId, templateId);

    let streak = 0;
    for (const run of recentRuns) {
      const failed = ['blocked', 'failed', 'validation_failed'].includes(run.final_status)
        || !!run.failure_bucket;
      if (!failed) break;
      streak++;
    }
    return streak;
  }

  _isCircuitOpen(template, now = new Date()) {
    if (!template || !template.circuit_open_until) return false;
    const until = new Date(template.circuit_open_until);
    return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
  }

  _buildReport(result) {
    return JSON.stringify({
      checked_at: new Date().toISOString(),
      success: result.success,
      reason: result.reason,
      blockers: result.blockers || [],
      notes: result.notes || [],
      failure_streak: result.failureStreak || 0,
      circuit_open_until: result.circuitOpenUntil || null
    });
  }

  _persistPreflight(template, result) {
    return Todo.update(template.agent_id, template.id, {
      lastPreflightAt: new Date().toISOString(),
      lastPreflightStatus: result.success ? 'passed' : 'blocked',
      lastPreflightReport: this._buildReport(result),
      circuitOpenUntil: result.circuitOpenUntil !== undefined ? result.circuitOpenUntil : template.circuit_open_until
    });
  }

  _openCircuit(template, failureStreak, reason) {
    const until = new Date(Date.now() + this.cooldownMinutes * 60 * 1000).toISOString();
    const updated = Todo.update(template.agent_id, template.id, {
      circuitOpenUntil: until,
      lastPreflightAt: new Date().toISOString(),
      lastPreflightStatus: 'blocked',
      lastPreflightReport: this._buildReport({
        success: false,
        reason,
        failureStreak,
        blockers: [`模板连续失败 ${failureStreak} 次，熔断 ${this.cooldownMinutes} 分钟`],
        circuitOpenUntil: until
      })
    });

    JobRunService.appendSchedulerEvent(template.agent_id, 'template_circuit_opened', {
      templateId: template.id,
      eventStatus: 'warn',
      details: {
        title: template.title,
        failure_streak: failureStreak,
        cooldown_minutes: this.cooldownMinutes,
        circuit_open_until: until
      }
    });

    Context.create(template.agent_id, {
      sessionId: 'scheduler',
      role: 'system',
      content: `[TemplatePreflight] 模板「${template.title}」连续失败 ${failureStreak} 次，已熔断至 ${until}`,
      metadata: { type: 'template_circuit_opened', template_id: template.id, failure_streak: failureStreak, circuit_open_until: until }
    });
    Notification.create(template.agent_id, template.id, 'blocked',
      `模板「${template.title}」连续失败 ${failureStreak} 次，已暂停自动调度 ${this.cooldownMinutes} 分钟`
    );

    return updated;
  }

  evaluateBeforeSpawn(agentId, template) {
    const currentTemplate = Todo.findById(agentId, template.id) || template;
    const now = new Date();
    const failureStreak = this._calculateFailureStreak(agentId, currentTemplate.id);
    const hadCircuit = !!currentTemplate.circuit_open_until;
    const circuitExpired = hadCircuit && !this._isCircuitOpen(currentTemplate, now);

    if (this._isCircuitOpen(currentTemplate, now)) {
      JobRunService.appendSchedulerEvent(agentId, 'template_circuit_blocked', {
        templateId: currentTemplate.id,
        eventStatus: 'warn',
        details: {
          title: currentTemplate.title,
          circuit_open_until: currentTemplate.circuit_open_until,
          failure_streak: failureStreak
        }
      });
      return {
        allowed: false,
        reason: 'template_circuit_open',
        blockers: [`模板熔断中，暂停至 ${currentTemplate.circuit_open_until}`],
        failureStreak,
        circuitOpenUntil: currentTemplate.circuit_open_until
      };
    }

    const lastSpawnedAt = currentTemplate.last_spawned_at ? new Date(currentTemplate.last_spawned_at) : null;
    const circuitOpenUntil = currentTemplate.circuit_open_until ? new Date(currentTemplate.circuit_open_until) : null;
    const hasRunAfterCircuit = lastSpawnedAt && circuitOpenUntil && lastSpawnedAt.getTime() > circuitOpenUntil.getTime();

    if (failureStreak >= this.failureThreshold && (!circuitExpired || hasRunAfterCircuit)) {
      const opened = this._openCircuit(currentTemplate, failureStreak, 'failure_streak_exceeded');
      return {
        allowed: false,
        reason: 'template_circuit_opened',
        blockers: [`模板连续失败 ${failureStreak} 次，已触发熔断`],
        failureStreak,
        circuitOpenUntil: opened.circuit_open_until
      };
    }

    if (circuitExpired) {
      Todo.update(agentId, currentTemplate.id, { circuitOpenUntil: null });
    }

    const preflight = CommandExecutor.preflightFromTask(currentTemplate);
    if (!preflight) {
      const updated = this._persistPreflight(currentTemplate, {
        success: true,
        reason: 'no_explicit_preflight',
        notes: ['模板未声明显式 preflight 规范，按现有调度流程继续'],
        failureStreak,
        circuitOpenUntil: null
      });
      if (updated.circuit_open_until) {
        Todo.update(agentId, currentTemplate.id, { circuitOpenUntil: null });
      }
      return {
        allowed: true,
        reason: 'no_explicit_preflight',
        notes: ['模板未声明显式 preflight 规范，按现有调度流程继续'],
        failureStreak
      };
    }

    if (preflight.blockers && preflight.blockers.length > 0) {
      const updated = this._persistPreflight(currentTemplate, {
        success: false,
        reason: 'template_preflight_blocked',
        blockers: preflight.blockers,
        notes: preflight.notes,
        failureStreak
      });
      JobRunService.appendSchedulerEvent(agentId, 'template_preflight_blocked', {
        templateId: updated.id,
        eventStatus: 'warn',
        details: {
          title: updated.title,
          blockers: preflight.blockers,
          notes: preflight.notes,
          failure_streak: failureStreak
        }
      });
      Context.create(agentId, {
        sessionId: 'scheduler',
        role: 'system',
        content: `[TemplatePreflight] 模板「${updated.title}」预检失败：${preflight.blockers.join('；')}`,
        metadata: { type: 'template_preflight_blocked', template_id: updated.id, blockers: preflight.blockers, notes: preflight.notes }
      });
      return {
        allowed: false,
        reason: 'template_preflight_blocked',
        blockers: preflight.blockers,
        notes: preflight.notes,
        failureStreak
      };
    }

    const updated = this._persistPreflight(currentTemplate, {
      success: true,
      reason: 'template_preflight_passed',
      blockers: [],
      notes: preflight.notes,
      failureStreak,
      circuitOpenUntil: null
    });
    if (updated.circuit_open_until) {
      Todo.update(agentId, currentTemplate.id, { circuitOpenUntil: null });
    }
    JobRunService.appendSchedulerEvent(agentId, 'template_preflight_passed', {
      templateId: updated.id,
      eventStatus: 'success',
      details: {
        title: updated.title,
        notes: preflight.notes,
        failure_streak: failureStreak
      }
    });
    return {
      allowed: true,
      reason: 'template_preflight_passed',
      notes: preflight.notes,
      failureStreak
    };
  }

  getTemplatePreflightSummary(agentId, templateId) {
    const template = Todo.findById(agentId, templateId);
    if (!template) return null;
    return {
      id: template.id,
      title: template.title,
      circuit_open_until: template.circuit_open_until || null,
      last_preflight_at: template.last_preflight_at || null,
      last_preflight_status: template.last_preflight_status || null,
      last_preflight_report: safeJsonParse(template.last_preflight_report, null)
    };
  }
}

module.exports = TemplatePreflightService;
