const { getDb } = require('../db');
const Todo = require('../models/Todo');

const MARKET_TASK_TITLES = [
  '每日 A股数据同步到 SQLite stock.db',
  '每日大宗交易数据增量同步（block_trade）',
  '每日沪深港通数据增量同步（hsgt）',
  '每日涨跌停数据增量同步（stk_limit）',
  '每日复权因子数据增量同步（adj_factor）',
  '每日分红数据增量同步（dividend）',
  '每日龙虎榜数据增量同步（top_list）',
  '每日资金流向数据增量同步（moneyflow）'
];

class MarketTaskRecoveryService {
  static prepareTaskForRecovery(agentId, task) {
    const fresh = Todo.findById(agentId, task.id);
    if (!fresh) return null;

    if (['blocked', 'failed', 'validation_failed'].includes(fresh.status)) {
      const currentAttempts = fresh.attempt_count || 0;
      const maxAttempts = fresh.max_attempts || 3;
      if (currentAttempts >= maxAttempts) {
        return fresh;
      }

      Todo.update(agentId, fresh.id, {
        status: 'in_progress',
        attemptCount: currentAttempts + 1,
        heartbeatStep: 'MarketTaskRecoveryService 自动恢复，继续执行',
        attemptLog: [...(fresh.attempt_log || []), {
          timestamp: new Date().toISOString(),
          action: 'market_recovery',
          reason: `recover_from_${fresh.status}`
        }]
      });
      return Todo.findById(agentId, fresh.id);
    }

    if (fresh.status === 'pending') {
      Todo.updateStatus(agentId, fresh.id, 'in_progress');
      return Todo.findById(agentId, fresh.id);
    }

    return fresh;
  }

  static getTodayLatestTasks(agentId, titles = MARKET_TASK_TITLES) {
    const db = getDb();
    const rows = db.prepare(`
      SELECT *
      FROM todos
      WHERE agent_id = ?
        AND is_template = 0
        AND title IN (${titles.map(() => '?').join(',')})
        AND date(created_at, 'localtime') = date('now', 'localtime')
        AND (archived = 0 OR archived IS NULL)
      ORDER BY title ASC, datetime(created_at) DESC
    `).all(agentId, ...titles);

    const latestByTitle = new Map();
    for (const row of rows) {
      if (!latestByTitle.has(row.title)) {
        latestByTitle.set(row.title, Todo.findById(agentId, row.id) || row);
      }
    }

    return titles.map(title => latestByTitle.get(title)).filter(Boolean);
  }

  static async recoverTodayTasks(agentId, driveOrchestrator, options = {}) {
    const {
      titles = MARKET_TASK_TITLES,
      source = 'market_recovery_service',
      reason = 'recover_today_market_tasks',
      maxForcedAttempts = 5
    } = options;

    const tasks = this.getTodayLatestTasks(agentId, titles);
    const results = [];

    for (const task of tasks) {
      const fresh = this.prepareTaskForRecovery(agentId, task);
      if (!fresh) {
        results.push({ title: task.title, task_id: task.id, skipped: true, reason: 'not_found' });
        continue;
      }

      if (['completed', 'cancelled'].includes(fresh.status)) {
        results.push({ title: fresh.title, task_id: fresh.id, skipped: true, reason: `status_${fresh.status}` });
        continue;
      }

      const archived = Todo.archiveSiblingActiveInstances(agentId, fresh.id, {
        reason: 'market_task_recovery_service'
      });

      const driveResult = await driveOrchestrator.triggerTaskDrive(agentId, fresh.id, {
        source,
        reason,
        waitForCompletion: true,
        setFocus: false,
        allowPendingChildren: true,
        maxForcedAttempts
      });

      const latest = Todo.findById(agentId, fresh.id);
      results.push({
        title: fresh.title,
        task_id: fresh.id,
        before_status: fresh.status,
        after_status: latest?.status,
        archived_siblings: archived.map(item => item.id),
        queued: !!driveResult?.queued,
        started: !!driveResult?.started,
        result: driveResult?.result || driveResult
      });
    }

    return {
      agent_id: agentId,
      processed: tasks.length,
      results
    };
  }
}

MarketTaskRecoveryService.MARKET_TASK_TITLES = MARKET_TASK_TITLES;

module.exports = MarketTaskRecoveryService;
