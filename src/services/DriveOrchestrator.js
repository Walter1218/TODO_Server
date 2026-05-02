const { getDb } = require('../db');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const Agent = require('../models/Agent');
const CommandExecutor = require('./CommandExecutor');
const ProgressValidator = require('./ProgressValidator');
const ValidatorService = require('./ValidatorService');
const ValidationDispatchService = require('./ValidationDispatchService');
const { buildDrivePrompt, parseHeartbeatReply } = require('../utils/driveHelper');

const DEFAULTS = {
  intervalMs: 60 * 1000,
  maxRetries: 3,
  retryBackoffMs: [0, 5000, 15000],
  driveCooldownMs: 60 * 1000,
  stallThreshold: 30 * 60 * 1000,
  maxConcurrentDrives: 3,
  useThirdPartyValidation: true,
};

class DriveOrchestrator {
  constructor(options = {}) {
    this.intervalMs = options.intervalMs || DEFAULTS.intervalMs;
    this.maxRetries = options.maxRetries || DEFAULTS.maxRetries;
    this.retryBackoffMs = options.retryBackoffMs || DEFAULTS.retryBackoffMs;
    this.driveCooldownMs = options.driveCooldownMs || DEFAULTS.driveCooldownMs;
    this.stallThreshold = options.stallThreshold || DEFAULTS.stallThreshold;
    this.maxConcurrentDrives = options.maxConcurrentDrives || DEFAULTS.maxConcurrentDrives;
    this.useThirdPartyValidation = options.useThirdPartyValidation !== undefined ? options.useThirdPartyValidation : DEFAULTS.useThirdPartyValidation;
    this.drivingTasks = new Set();
    this.framework = null;
    this.validator = null;
    this.validationDispatcher = null;
    this._timer = null;
  }

  start(framework) {
    this.framework = framework;
    this.validator = new ValidatorService(framework);
    this.validationDispatcher = new ValidationDispatchService();
    this._timer = setInterval(() => this.tick().catch(err => {
      console.error('[DriveOrchestrator] tick error:', err.message);
    }), this.intervalMs);
    console.log(`[DriveOrchestrator] 已启动，每 ${this.intervalMs / 1000}s 扫描一次，第三方验证: ${this.useThirdPartyValidation ? '启用' : '禁用'}`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  shouldDrive(task) {
    if (!task) return false;
    const drivable = ['pending', 'in_progress', 'pending_validation', 'validation_failed'].includes(task.status);
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
    if (task.status === 'validation_failed') {
      const currentAttempts = task.attempt_count || 0;
      const maxAttempts = task.max_attempts || 3;
      if (currentAttempts < maxAttempts) {
        let feedback = '';
        if (task.validation_report) {
          try {
            const report = JSON.parse(task.validation_report);
            feedback = report.feedback || '';
          } catch (e) {
            console.error('[DriveOrchestrator] 解析 validation_report 失败:', e.message);
          }
        }

        Todo.update(task.agent_id, task.id, {
          status: 'in_progress',
          attemptCount: currentAttempts + 1,
          heartbeatStep: `🔄 校验失败重试中，参考反馈: ${feedback.substring(0, 50)}...`,
          attemptLog: [...(task.attempt_log || []), {
            timestamp: new Date().toISOString(),
            success: false,
            reason: 'ValidatorService 校验失败，自动重试',
            output: feedback || 'No feedback available',
          }],
        });
        const refreshed = Todo.findById(task.agent_id, task.id);
        refreshed._validationFeedback = feedback;
        return refreshed;
      }
    }
    return task;
  }

  buildRetryContext(reply, results, attempt, validationFeedback) {
    const failedOutput = results
      ? results.filter(r => !r.success).map(r => `[失败] ${r.command}: ${r.output}`).join('; ')
      : '';
    const baseMsg = `【自动重试 #${attempt + 1}】`;
    const progressMsg = failedOutput ? `失败命令: ${failedOutput}` : '上次回复未能推进任务，请分析原因并换一种方式继续。';
    const validationMsg = validationFeedback ? `\n\n📋 上次验证失败反馈（请务必解决）:\n${validationFeedback}` : '';
    return `${baseMsg}${progressMsg}${validationMsg}`;
  }

  async driveTask(agentId, task) {
    const task_ = await this.prepareTaskState(task);
    if (!task_) return { success: false, attempts: 0, reason: 'prepare_failed' };

    let attempt = 0;
    let retryContext = task_._validationFeedback ? `📋 验证失败反馈（请务必解决）:\n${task_._validationFeedback}` : null;
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
        const refreshedForValidation = Todo.findById(agentId, task_.id);
        if (refreshedForValidation.heartbeat_progress >= 100) {
          await Context.create(agentId, {
            sessionId: 'drive-orchestrator',
            role: 'system',
            content: `[DriveOrchestrator] 任务进度达到 100%，自动触发验证流程`,
            metadata: { type: 'auto_validation_trigger', task_id: task_.id },
          });
          Todo.update(agentId, task_.id, { status: 'pending_validation' });
          return { success: true, validationTriggered: true, attempts: attempt + 1 };
        }
        return { success: true, attempts: attempt + 1, reply, commands: execResults, changed };
      }

      lastReply = reply;
      lastResults = execResults;
      retryContext = this.buildRetryContext(reply, execResults, attempt, task_._validationFeedback || null);
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
        if (task.status === 'pending_validation') {
          if (this.useThirdPartyValidation) {
            const recent = await Context.findRecentByAgent(agent.id, 200);
            const related = recent.filter(c => (c.metadata || {}).task_id === task.id);
            const logs = related.map(c => `[${c.session_id || 'session'}][${c.role}] ${c.content}`).join('\n---\n');
            await this.validationDispatcher.dispatchValidationTask(agent.id, task, logs);
            Todo.update(agent.id, task.id, { heartbeatStep: '📋 已派发第三方验证任务，等待验证报告...' });
            totalDriven++;
          } else {
            const validationResult = await this.validator.validateTask(agent.id, task);
            if (validationResult.pass) {
              totalDriven++;
            }
          }
        } else {
          const result = await this.driveTask(agent.id, task);
          if (result.success) {
            totalDriven++;
          } else if (result.stalled) {
            totalStalled++;
          }
        }
      } catch (err) {
        console.error(`[DriveOrchestrator] driveTask ${task.id} error:`, err.message);
      } finally {
        this.drivingTasks.delete(task.id);
      }
    }

    if (concurrent < this.maxConcurrentDrives) {
      const validateCutoff = new Date(Date.now() - 30 * 1000).toISOString();
      const limit = Math.max(0, this.maxConcurrentDrives - concurrent);
      const pendingValidations = db.prepare(`
        SELECT * FROM todos
        WHERE status = 'pending_validation'
          AND is_template = 0
          AND archived = 0
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(validateCutoff, limit);

      for (const pv of pendingValidations) {
        if (concurrent >= this.maxConcurrentDrives) break;
        if (this.drivingTasks.has(pv.id)) continue;

        this.drivingTasks.add(pv.id);
        concurrent++;
        try {
          if (this.useThirdPartyValidation) {
            const recent = await Context.findRecentByAgent(pv.agent_id, 200);
            const related = recent.filter(c => (c.metadata || {}).task_id === pv.id);
            const logs = related.map(c => `[${c.session_id || 'session'}][${c.role}] ${c.content}`).join('\n---\n');
            await this.validationDispatcher.dispatchValidationTask(pv.agent_id, pv, logs);
            Todo.update(pv.agent_id, pv.id, { heartbeatStep: '📋 已派发第三方验证任务，等待验证报告...' });
            totalDriven++;
          } else {
            const validationResult = await this.validator.validateTask(pv.agent_id, pv);
            if (validationResult.pass) {
              totalDriven++;
            }
          }
        } catch (err) {
          console.error(`[DriveOrchestrator] validateTask ${pv.id} error:`, err.message);
        } finally {
          this.drivingTasks.delete(pv.id);
        }
      }
    }

    if (concurrent < this.maxConcurrentDrives) {
      const failedRetryCutoff = new Date(Date.now() - 60 * 1000).toISOString();
      const limit = Math.max(0, this.maxConcurrentDrives - concurrent);
      const failedTasks = db.prepare(`
        SELECT * FROM todos
        WHERE status = 'validation_failed'
          AND is_template = 0
          AND archived = 0
          AND attempt_count < max_attempts
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(failedRetryCutoff, limit);

      for (const ft of failedTasks) {
        if (concurrent >= this.maxConcurrentDrives) break;
        if (this.drivingTasks.has(ft.id)) continue;

        this.drivingTasks.add(ft.id);
        concurrent++;
        try {
          const result = await this.driveTask(ft.agent_id, ft);
          if (result.success) {
            totalDriven++;
          }
        } catch (err) {
          console.error(`[DriveOrchestrator] driveTask (retry) ${ft.id} error:`, err.message);
        } finally {
          this.drivingTasks.delete(ft.id);
        }
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

    const completedTasks = db.prepare(`
      SELECT * FROM todos
      WHERE status = 'in_progress'
        AND heartbeat_progress >= 100
        AND is_template = 0
        AND archived = 0
    `).all();

    for (const ct of completedTasks) {
      await Context.create(ct.agent_id, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: `[DriveOrchestrator] 检测到任务进度 100%，自动触发验证流程`,
        metadata: { type: 'auto_validation_trigger', task_id: ct.id },
      });
      Todo.update(ct.agent_id, ct.id, { status: 'pending_validation' });
    }

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
