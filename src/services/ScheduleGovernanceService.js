const { getDb } = require('../db');
const Agent = require('../models/Agent');

function parseIntOr(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePolicyOverrides(text = '') {
  const source = String(text || '');
  const getValue = (key) => {
    const match = source.match(new RegExp(`${key}\\s*=\\s*(\\d+)`, 'i'));
    return match ? parseIntOr(match[1], null) : null;
  };

  return {
    maxActiveInstances: getValue('MAX_ACTIVE_INSTANCES'),
    burstLimit: getValue('SCHEDULE_BURST_LIMIT'),
    burstWindowMinutes: getValue('SCHEDULE_BURST_WINDOW_MINUTES')
  };
}

function toSqliteTimestamp(date) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

class ScheduleGovernanceService {
  constructor(options = {}) {
    this.defaultPerTemplateActiveLimit = options.defaultPerTemplateActiveLimit
      || parseIntOr(process.env.SCHEDULE_TEMPLATE_ACTIVE_LIMIT, 1);
    this.defaultBurstLimit = options.defaultBurstLimit
      || parseIntOr(process.env.SCHEDULE_BURST_LIMIT, 2);
    this.defaultBurstWindowMinutes = options.defaultBurstWindowMinutes
      || parseIntOr(process.env.SCHEDULE_BURST_WINDOW_MINUTES, 5);
  }

  getPolicy(template) {
    const overrides = parsePolicyOverrides(template?.description || '');
    const category = template?.task_category || 'general';

    const policy = {
      maxActiveInstances: overrides.maxActiveInstances || this.defaultPerTemplateActiveLimit,
      burstLimit: overrides.burstLimit || this.defaultBurstLimit,
      burstWindowMinutes: overrides.burstWindowMinutes || this.defaultBurstWindowMinutes,
      category
    };

    if (category === 'inspection' || category === 'backup') {
      policy.burstLimit = Math.min(policy.burstLimit, 1);
    }

    return policy;
  }

  evaluateBeforeSpawn(agentId, template, options = {}) {
    const db = getDb();
    const policy = this.getPolicy(template);
    const { enforceAgentCapacity = false } = options;

    const sameTemplateActive = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM todos
      WHERE agent_id = ?
        AND parent_id = ?
        AND status IN ('pending', 'in_progress', 'pending_validation', 'validating')
        AND (archived = 0 OR archived IS NULL)
    `).get(agentId, template.id).cnt;

    if (sameTemplateActive >= policy.maxActiveInstances) {
      return {
        allowed: false,
        reason: 'template_active_limit',
        details: {
          title: template.title,
          active_instances: sameTemplateActive,
          max_active_instances: policy.maxActiveInstances
        }
      };
    }

    const agentCapacity = Agent.canAcceptNewTask(agentId);
    if (enforceAgentCapacity && !agentCapacity.canAccept) {
      return {
        allowed: false,
        reason: 'agent_capacity_reached',
        details: {
          title: template.title,
          active_tasks: agentCapacity.active,
          max_concurrent: agentCapacity.max
        }
      };
    }

    const burstCutoff = toSqliteTimestamp(Date.now() - policy.burstWindowMinutes * 60 * 1000);
    const recentSpawns = db.prepare(`
      SELECT COUNT(*) as cnt
      FROM scheduler_events
      WHERE agent_id = ?
        AND event_type = 'task_spawned'
        AND created_at >= ?
    `).get(agentId, burstCutoff).cnt;

    if (recentSpawns >= policy.burstLimit) {
      return {
        allowed: false,
        reason: 'agent_spawn_burst_limit',
        details: {
          title: template.title,
          recent_spawns: recentSpawns,
          burst_limit: policy.burstLimit,
          burst_window_minutes: policy.burstWindowMinutes
        }
      };
    }

    return {
      allowed: true,
      reason: 'governance_passed',
      details: {
        title: template.title,
        agent_at_capacity: !agentCapacity.canAccept,
        active_tasks: agentCapacity.active,
        max_concurrent: agentCapacity.max,
        active_instances: sameTemplateActive,
        max_active_instances: policy.maxActiveInstances,
        recent_spawns: recentSpawns,
        burst_limit: policy.burstLimit,
        burst_window_minutes: policy.burstWindowMinutes
      }
    };
  }
}

module.exports = ScheduleGovernanceService;
