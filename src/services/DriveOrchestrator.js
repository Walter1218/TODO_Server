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
    const drivable = ['pending', 'in_progress', 'validation_failed', 'validating'].includes(task.status);
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
            action: 'auto_retry',
            reason: 'blocked task auto recovered',
          }],
        });
        return Todo.findById(task.agent_id, task.id);
      } else {
        Todo.updateStatus(task.agent_id, task.id, 'validation_failed');
        Notification.create(task.agent_id, task.id, 'max_attempts',
          `❌ 任务「${task.title}」已达到最大重试次数`
        );
        return null;
      }
    }
    return task;
  }

  buildRetryContext(reply, results, attempt, validationFeedback) {
    const baseMsg = `任务执行遇到问题，正在进行第 ${attempt + 1} 次重试...`;
    const progressMsg = results?.length > 0 ? `\n\n📊 上次执行结果:\n${CommandExecutor.buildExecutionSummary(results)}` : '';
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

      if (attempt + 1 < this.maxRetries) {
        retryContext = this.buildRetryContext(lastReply, lastResults, attempt, task_._validationFeedback || null);
      }
      attempt++;
    }

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

    if (concurrent < this.maxConcurrentDrives) {
      const validateCutoff = new Date(Date.now() - 30 * 1000).toISOString();
      const limit = Math.max(0, this.maxConcurrentDrives - concurrent);
      const pendingValidations = db.prepare(`
        SELECT * FROM todos
        WHERE status = 'pending_validation'
          AND is_template = 0
          AND archived = 0
          AND updated_at <= ?
          AND (
            title NOT LIKE '[验证]%'
            OR context NOT LIKE '%"type":"third_party_validation"%'
          )
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
            Todo.update(pv.agent_id, pv.id, {
              status: 'validating',
              heartbeatStep: '📋 已派发第三方验证任务，等待验证报告...'
            });
            totalDriven++;
          } else {
            const validationResult = await this.validator.validateTask(pv.agent_id, pv);
            if (validationResult.pass) {
              Todo.updateStatus(pv.agent_id, pv.id, 'completed');
              totalDriven++;
            } else {
              Todo.updateStatus(pv.agent_id, pv.id, 'validation_failed');
              totalStalled++;
            }
          }
        } catch (err) {
          console.error(`[DriveOrchestrator] validation ${pv.id} error:`, err.message);
        } finally {
          this.drivingTasks.delete(pv.id);
        }
      }
    }

    if (concurrent < this.maxConcurrentDrives) {
      const limit = Math.max(0, this.maxConcurrentDrives - concurrent);
      const stalledTasks = db.prepare(`
        SELECT * FROM todos
        WHERE status = 'validation_failed'
          AND is_template = 0
          AND archived = 0
          AND attempt_count < max_attempts
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(limit);

      for (const ft of stalledTasks) {
        if (concurrent >= this.maxConcurrentDrives) break;
        if (this.drivingTasks.has(ft.id)) continue;

        this.drivingTasks.add(ft.id);
        concurrent++;
        try {
          const result = await this.driveTask(ft.agent_id, ft);
          if (result.success) {
            totalDriven++;
          } else if (result.stalled) {
            totalStalled++;
          }
        } catch (err) {
          console.error(`[DriveOrchestrator] driveTask (retry) ${ft.id} error:`, err.message);
        } finally {
          this.drivingTasks.delete(ft.id);
        }
      }
    }

    if (totalDriven > 0 || totalStalled > 0) {
      console.log(`[DriveOrchestrator] tick 完成: 驱动 ${totalDriven} 个任务，${totalStalled} 个任务卡住`);
    }

    return { totalDriven, totalStalled };
  }
}

module.exports = DriveOrchestrator;
