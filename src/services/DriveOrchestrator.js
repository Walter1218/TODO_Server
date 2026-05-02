const { getDb } = require('../db');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const Agent = require('../models/Agent');
const CommandExecutor = require('./CommandExecutor');
const ProgressValidator = require('./ProgressValidator');
const { buildDrivePrompt, parseHeartbeatReply } = require('../utils/driveHelper');

const DEFAULTS = {
  intervalMs: 60 * 1000,
  maxRetries: 3,
  retryBackoffMs: [0, 5000, 15000],
  driveCooldownMs: 60 * 1000,
  stallThreshold: 30 * 60 * 1000,
  maxConcurrentDrives: 3,
};

class DriveOrchestrator {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || DEFAULTS.intervalMs;
    this.maxRetries = options.maxRetries || DEFAULTS.maxRetries;
    this.retryBackoffMs = options.retryBackoffMs || DEFAULTS.retryBackoffMs;
    this.driveCooldownMs = options.driveCooldownMs || DEFAULTS.driveCooldownMs;
    this.stallThreshold = options.stallThreshold || DEFAULTS.stallThreshold;
    this.maxConcurrentDrives = options.maxConcurrentDrives || DEFAULTS.maxConcurrentDrives;
    this.drivingTasks = new Set();
    this.framework = null;
    this._timer = null;
  }

  start(framework) {
    this.framework = framework;
    this._timer = setInterval(() => this.tick().catch(err => {
      console.error('[DriveOrchestrator] tick error:', err.message);
    }), this.intervalMs);
    console.log(`[DriveOrchestrator] 已启动，每 ${this.intervalMs / 1000}s 扫描一次`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  shouldDrive(task) {
    if (!task) return false;
    const drivable = ['pending', 'in_progress'].includes(task.status);
    if (!drivable) return false;
    if (this.drivingTasks.has(task.id)) return false;
    if (task.is_template) return false;
    if (task.archived) return false;
    if (task.last_driven_at) {
      const ago = Date.now() - new Date(task.last_driven_at).getTime();
      if (ago < this.driveCooldownMs) return false;
    }
    return true;
  }

  async prepareTaskState(task) {
    if (task.status === 'pending') {
      Todo.updateStatus(task.agent_id, task.id, 'in_progress');
      return Todo.findById(task.agent_id, task.id);
    }
    if (task.status === 'blocked') {
      const currentAttempts = task.attempt_count || 0;
      const maxAttempts = task.max_attempts || 3;
      if (currentAttempts < maxAttempts) {
        Todo.update(task.agent_id, task.id, {
          status: 'in_progress',
          attemptCount: currentAttempts + 1,
          heartbeatStep: 'DriveOrchestrator 自动恢复，继续执行',
          attemptLog: [...(task.attempt_log || []), {
            timestamp: new Date().toISOString(),
            success: true,
            reason: 'DriveOrchestrator 自动恢复',
            output: 'Blocked task recovered by DriveOrchestrator',
          }],
        });
        return Todo.findById(task.agent_id, task.id);
      }
    }
    return task;
  }

  buildRetryContext(reply, results, attempt) {
    const failedOutput = results
      ? results.filter(r => !r.success).map(r => `[失败] ${r.command}: ${r.output}`).join('; ')
      : '';
    return `【自动重试 #${attempt + 1}】上次回复未能推进任务。${failedOutput ? '失败命令: ' + failedOutput : '请分析上次回复为何无效，换一种方式继续。'}`;
  }

  async driveTask(agentId, task) {
    const task_ = await this.prepareTaskState(task);
    if (!task_) return { success: false, attempts: 0, reason: 'prepare_failed' };

    let attempt = 0;
    let retryContext = null;
    let lastResults = null;
    let lastReply = null;

    while (attempt < this.maxRetries) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, this.retryBackoffMs[attempt] || 0));
      }

      const before = ProgressValidator.snapshot(task_);

      const prompt = buildDrivePrompt(task_, { isManual: false, retryContext });
      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: `[DriveOrchestrator] 驱动任务「${task_.title}」attempt=${attempt + 1}${retryContext ? ' | ' + retryContext : ''}`,
        metadata: { type: 'drive_request', task_id: task_.id, attempt: attempt + 1 },
      });

      let reply;
      try {
        const result = await this.framework.processMessage(prompt);
        reply = result.response?.message || '';
      } catch (llmErr) {
        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'system',
          content: `[DriveOrchestrator] LLM 调用失败: ${llmErr.message}`,
          metadata: { type: 'llm_error', task_id: task_.id, attempt: attempt + 1 },
        });
        attempt++;
        retryContext = `【自动重试 #${attempt + 1}】LLM 调用失败: ${llmErr.message}`;
        continue;
      }

      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'assistant',
        content: `[DriveOrchestrator] LLM 回复 attempt=${attempt + 1}:\n${reply.substring(0, 500)}`,
        metadata: { type: 'llm_reply', task_id: task_.id, reply_length: reply.length },
      });

      let execResults = [];
      const { commands, results } = await CommandExecutor.extractAndRun(reply, { task: task_ });
      if (commands.length > 0) {
        execResults = results || [];
        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'system',
          content: `[DriveOrchestrator] 命令执行结果:\n${CommandExecutor.buildExecutionSummary(execResults)}`,
          metadata: { type: 'command_exec', task_id: task_.id, commands_count: commands.length },
        });
      }

      const parsed = parseHeartbeatReply(task_, reply);
      if (parsed.changed) {
        Todo.updateHeartbeat(agentId, task_.id, {
          progress: parsed.progress,
          step: parsed.step,
          blockers: parsed.blockers,
        });
      }

      const db = getDb();
      db.prepare(`UPDATE todos SET last_driven_at = CURRENT_TIMESTAMP WHERE id = ?`).run(task_.id);

      const refreshed = Todo.findById(agentId, task_.id);
      const after = ProgressValidator.snapshot(refreshed);
      const { changed } = ProgressValidator.compare(before, after);

      const report = ProgressValidator.buildReport(task_.id, before, after, { success: changed, attempts: attempt + 1 });
      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: report,
        metadata: { type: 'progress_report', task_id: task_.id },
      });

      if (changed) {
        return { success: true, attempts: attempt + 1, reply, commands: execResults, changed };
      }

      lastReply = reply;
      lastResults = execResults;
      retryContext = this.buildRetryContext(reply, execResults, attempt);
      attempt++;
    }

    await Context.create(agentId, {
      sessionId: 'drive-orchestrator',
      role: 'system',
      content: `[DriveOrchestrator] ⚠️ 任务「${task_.title}」重试 ${this.maxRetries} 次均无进展，标记为等待人工介入`,
      metadata: { type: 'stalled', task_id: task_.id, attempts: this.maxRetries },
    });

    Notification.create(agentId, task_.id, 'stalled',
      `⚠️ 任务「${task_.title}」执行多次无进展，请人工介入检查`
    );

    Todo.update(agentId, task_.id, {
      heartbeatStep: '⚠️ 等待人工介入',
    });

    return { success: false, attempts: this.maxRetries, reply: lastReply, commands: lastResults, stalled: true };
  }

  async tick() {
    const db = getDb();
    const agents = Agent.findAll();
    let totalDriven = 0;
    let totalStalled = 0;
    let concurrent = 0;

    for (const agent of agents) {
      if (concurrent >= this.maxConcurrentDrives) break;

      const focus = FocusState.findByAgent(agent.id);
      if (!focus || !focus.current_task_id) continue;

      const task = Todo.findById(agent.id, focus.current_task_id);
      if (!this.shouldDrive(task)) continue;

      this.drivingTasks.add(task.id);
      concurrent++;
      try {
        const result = await this.driveTask(agent.id, task);
        if (result.success) {
          totalDriven++;
        } else if (result.stalled) {
          totalStalled++;
        }
      } catch (err) {
        console.error(`[DriveOrchestrator] driveTask ${task.id} error:`, err.message);
      } finally {
        this.drivingTasks.delete(task.id);
      }
    }

    const staleThreshold = new Date(Date.now() - this.stallThreshold).toISOString();
    const staleTasks = db.prepare(`
      SELECT * FROM todos
      WHERE status = 'in_progress'
        AND last_heartbeat IS NOT NULL
        AND last_heartbeat <= ?
        AND is_template = 0
        AND archived = 0
    `).all(staleThreshold);

    for (const staleTask of staleTasks) {
      if (totalStalled >= 5) break;
      Notification.create(staleTask.agent_id, staleTask.id, 'stalled',
        `⚠️ 任务「${staleTask.title}」超过 ${Math.round(this.stallThreshold / 60000)} 分钟无心跳，请人工介入`
      );
      Todo.update(staleTask.agent_id, staleTask.id, { heartbeatStep: '⚠️ 等待人工介入（超时无心跳）' });
      totalStalled++;
    }

    if (totalDriven > 0 || totalStalled > 0) {
      console.log(`[DriveOrchestrator] driven=${totalDriven} stalled=${totalStalled}`);
    }

    return { driven: totalDriven, stalled: totalStalled };
  }
}

module.exports = DriveOrchestrator;
