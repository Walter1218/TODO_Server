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
const { isValidationTask, shouldTriggerValidation, getTaskTypeLabel } = require('../utils/TaskType');

const DEFAULTS = {
  intervalMs: 60 * 1000,
  maxRetries: 3,
  retryBackoffMs: [0, 5000, 15000],
  driveCooldownMs: 60 * 1000,
  stallThreshold: 30 * 60 * 1000,
  maxConcurrentDrives: 5,
  useThirdPartyValidation: false,
  validationTimeoutMs: 30 * 60 * 1000,
  maxValidationAttempts: 3,
  validationCooldownMs: 2 * 60 * 1000,
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
    this.validationTimeoutMs = options.validationTimeoutMs || DEFAULTS.validationTimeoutMs;
    this.maxValidationAttempts = options.maxValidationAttempts || DEFAULTS.maxValidationAttempts;
    this.validationCooldownMs = options.validationCooldownMs || DEFAULTS.validationCooldownMs;
    this.drivingTasks = new Set();
    this.framework = null;
    this.validator = null;
    this.validationDispatcher = null;
    this._timer = null;
    this._tickRunning = false;
    this._validationTimeouts = new Map();
    this._lastGreetingCount = new Map();
  }

  detectGreetingLoop(reply, task) {
    const greetingPatterns = [
      '你好', '您好', '已就绪', '待命', '就绪', '已启动',
      'hello', 'hi', 'ready', 'ready to', 'initialized',
      '👋', '✅ 系统', '我能帮', '有什么'
    ];

    const isGreeting = greetingPatterns.some(p => reply.includes(p));
    const hasCommand = /```bash|^\$./m.test(reply) || reply.includes('fetch_') || reply.includes('python');

    if (isGreeting && !hasCommand) {
      const count = (this._lastGreetingCount.get(task.id) || 0) + 1;
      this._lastGreetingCount.set(task.id, count);
      if (count >= 2) {
        console.log(`[DriveOrchestrator] 任务 ${task.id} 检测到循环问候（第${count}次）`);
        return true;
      }
    } else {
      this._lastGreetingCount.set(task.id, 0);
    }
    return false;
  }

  forceExtractCommands(task) {
    const commands = [];
    const desc = task.description || '';

    const scriptMatches = desc.match(/fetch_[\w_]+\.py/g);
    if (scriptMatches) {
      scriptMatches.forEach((script, idx) => {
        const pathMatch = desc.match(new RegExp(`(/${script.replace('.py', '_v\\d*\\.py')}|${script.replace('.py', '\\.py')})`));
        const scriptPath = pathMatch ? pathMatch[0] : script;
        const argsMatch = desc.match(/--[\w\s]+/g);
        const args = argsMatch ? argsMatch.join(' ') : '';
        commands.push({
          index: idx,
          command: `python3 "${scriptPath}" ${args}`.trim(),
          source: 'forced'
        });
      });
    }

    const duckdbMatches = desc.match(/\/[\w\/]+\.duckdb/g);
    if (duckdbMatches) {
      duckdbMatches.slice(0, 2).forEach((path, idx) => {
        commands.push({
          index: commands.length,
          command: `python3 -c "import duckdb; conn = duckdb.connect('${path}'); print(conn.execute('SELECT table_name FROM information_schema.tables').fetchall())"`,
          source: 'forced'
        });
      });
    }

    console.log(`[DriveOrchestrator] 强制提取 ${commands.length} 个命令`);
    return commands;
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
    for (const timer of this._validationTimeouts.values()) {
      clearTimeout(timer);
    }
    this._validationTimeouts.clear();
  }

  scheduleValidationTimeoutCheck(taskId, agentId, timeoutMs) {
    if (this._validationTimeouts.has(taskId)) {
      return;
    }
    const timer = setTimeout(async () => {
      this._validationTimeouts.delete(taskId);
      const task = Todo.findById(agentId, taskId);
      if (!task || task.status !== 'validating') {
        return;
      }
      const deadline = task.validation_deadline ? new Date(task.validation_deadline).getTime() : 0;
      if (Date.now() <= deadline) {
        return;
      }
      console.log(`[DriveOrchestrator] 第三方验证超时，自动切换为内嵌验证: ${taskId}`);
      try {
        const result = await this.validator.validateTask(agentId, task);
        if (result.pass) {
          Todo.updateStatus(agentId, taskId, 'completed');
        } else if (result.exhausted) {
          Todo.update(agentId, taskId, {
            status: 'blocked',
            heartbeatStep: `🔒 验证次数已达上限(${this.maxValidationAttempts}次)，需要人工介入`
          });
        } else {
          Todo.updateStatus(agentId, taskId, 'validation_failed');
        }
      } catch (err) {
        console.error(`[DriveOrchestrator] 内嵌验证失败: ${err.message}`);
        Todo.updateStatus(agentId, taskId, 'validation_failed');
      }
      Context.create(agentId, {
        sessionId: 'validation-timeout-fallback',
        role: 'system',
        content: `[验证超时] 第三方验证在 ${timeoutMs / 60000} 分钟内未完成，自动切换为内嵌验证`,
        metadata: { type: 'validation_timeout_fallback', task_id: taskId }
      });
      Notification.create(agentId, taskId, 'validation_timeout',
        `任务「${task.title}」第三方验证超时，已自动切换为内嵌验证`
      );
    }, timeoutMs);
    this._validationTimeouts.set(taskId, timer);
  }

  shouldDrive(task) {
    if (!task) return false;
    const drivable = ['pending', 'in_progress'].includes(task.status);
    if (!drivable) return false;
    if (this.drivingTasks.has(task.id)) return false;
    if (task.is_template) return false;
    if (task.archived) return false;
    const vc = task.validation_count || 0;
    if (vc >= this.maxValidationAttempts) return false;
    if (task.parent_id && task.status === 'pending') return false;
    if (task.last_driven_at) {
      const ago = Date.now() - new Date(task.last_driven_at).getTime();
      if (ago < this.driveCooldownMs) return false;
    }
    return true;
  }

  _hasValidationExhausted(task) {
    const vc = task.validation_count || 0;
    if (vc >= this.maxValidationAttempts) return true;
    return false;
  }

  _hasValidationCooldown(task) {
    if (!task.updated_at) return false;
    const lastUpdate = new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime();
    return (Date.now() - lastUpdate) < this.validationCooldownMs;
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

      const isGreetingLoop = this.detectGreetingLoop(reply, task_);
      const isDataSyncTask = (task_.description || '').includes('fetch_') ||
                              (task_.description || '').includes('duckdb') ||
                              (task_.description || '').includes('同步');

      let execResults = [];
      let { commands, results } = await CommandExecutor.extractAndRun(reply, { task: task_ });

      if (isGreetingLoop && commands.length === 0) {
        console.log(`[DriveOrchestrator] 检测到循环问候模式，强制提取并执行命令: ${task_.id}`);
        commands = this.forceExtractCommands(task_);
      }

      if (commands.length > 0) {
        if (isGreetingLoop && results.length === 0) {
          execResults = await CommandExecutor.executeCommands(commands, { timeoutMs: 60000 });
        } else {
          execResults = results || [];
        }
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
          if (isValidationTask(refreshedForValidation)) {
            await Context.create(agentId, {
              sessionId: 'drive-orchestrator',
              role: 'system',
              content: `[DriveOrchestrator] ${getTaskTypeLabel(refreshedForValidation)}进度达到 100%，直接标记为完成`,
              metadata: { type: 'validation_task_complete', task_id: task_.id },
            });
            Todo.update(agentId, task_.id, { status: 'completed', heartbeatStep: '✅ 验证任务已完成' });
            return { success: true, validationTriggered: false, attempts: attempt + 1 };
          }

          if (shouldTriggerValidation(refreshedForValidation)) {
            if (this._hasValidationExhausted(refreshedForValidation)) {
              await Context.create(agentId, {
                sessionId: 'drive-orchestrator',
                role: 'system',
                content: `[DriveOrchestrator] 任务进度 100% 但验证已达上限(${this.maxValidationAttempts}次)，跳过验证`,
                metadata: { type: 'validation_skip_exhausted', task_id: task_.id }
              });
              return { success: true, attempts: attempt + 1, reply, commands: execResults, changed, validationSkipped: true };
            }
            await Context.create(agentId, {
              sessionId: 'drive-orchestrator',
              role: 'system',
              content: `[DriveOrchestrator] 任务进度达到 100%，自动触发验证流程`,
              metadata: { type: 'auto_validation_trigger', task_id: task_.id },
            });
            Todo.update(agentId, task_.id, { status: 'pending_validation' });
            return { success: true, validationTriggered: true, attempts: attempt + 1 };
          }
        }
        return { success: true, attempts: attempt + 1, reply, commands: execResults, changed };
      }

      if (!changed) {
        const freshTask = Todo.findById(agentId, task_.id);
        if (freshTask && freshTask.heartbeat_progress >= 100 && !isValidationTask(freshTask)) {
          if (shouldTriggerValidation(freshTask)) {
            if (this._hasValidationExhausted(freshTask)) {
              return { success: true, attempts: attempt + 1, reply, commands: execResults, changed, validationSkipped: true };
            }
            await Context.create(agentId, {
              sessionId: 'drive-orchestrator',
              role: 'system',
              content: `[DriveOrchestrator] 进度已达 100%（无新变化），兜底触发验证流程`,
              metadata: { type: 'fallback_validation_trigger', task_id: task_.id },
            });
            Todo.update(agentId, task_.id, { status: 'pending_validation' });
            return { success: true, validationTriggered: true, attempts: attempt + 1, changed: false };
          }
        }
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
    if (this._tickRunning) return { totalDriven: 0, totalStalled: 0 };
    this._tickRunning = true;
    try {
      return await this._tickInner();
    } finally {
      this._tickRunning = false;
    }
  }

  async _tickInner() {
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
      const validateCutoff = new Date(Date.now() - this.validationCooldownMs).toISOString();
      const limit = Math.max(0, this.maxConcurrentDrives - concurrent);
      const pendingValidations = db.prepare(`
        SELECT * FROM todos
        WHERE status = 'pending_validation'
          AND is_template = 0
          AND archived = 0
          AND updated_at <= ?
          AND (validation_count IS NULL OR validation_count < ?)
          AND (
            title NOT LIKE '[验证]%'
            OR context LIKE '%"type":"third_party_validation"%'
          )
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(validateCutoff, this.maxValidationAttempts, limit);

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
            const deadline = new Date(Date.now() + this.validationTimeoutMs).toISOString();
            Todo.update(pv.agent_id, pv.id, {
              status: 'validating',
              validationDeadline: deadline,
              heartbeatStep: `📋 已派发第三方验证任务，等待验证报告（超时: ${new Date(deadline).toLocaleString()}）...`
            });
            this.scheduleValidationTimeoutCheck(pv.id, pv.agent_id, this.validationTimeoutMs);
            totalDriven++;
          } else {
            const validationResult = await this.validator.validateTask(pv.agent_id, pv);
            if (validationResult.pass) {
              Todo.updateStatus(pv.agent_id, pv.id, 'completed');
              totalDriven++;
            } else {
              const refreshed = Todo.findById(pv.agent_id, pv.id);
              if (this._hasValidationExhausted(refreshed)) {
                Todo.update(pv.agent_id, pv.id, {
                  status: 'blocked',
                  heartbeatStep: `🔒 验证次数已达上限(${this.maxValidationAttempts}次)，需要人工介入`
                });
                Notification.create(pv.agent_id, pv.id, 'validation_exhausted',
                  `任务「${pv.title}」验证失败已达 ${this.maxValidationAttempts} 次，已标记为阻塞`
                );
              } else {
                Todo.updateStatus(pv.agent_id, pv.id, 'validation_failed');
              }
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
          AND (validation_count IS NULL OR validation_count < ?)
          AND updated_at <= ?
        ORDER BY updated_at ASC
        LIMIT ?
      `).all(this.maxValidationAttempts, new Date(Date.now() - this.validationCooldownMs).toISOString(), limit);

      for (const ft of stalledTasks) {
        if (concurrent >= this.maxConcurrentDrives) break;
        if (this.drivingTasks.has(ft.id)) continue;

        const refreshed = Todo.findById(ft.agent_id, ft.id);
        if (!refreshed || refreshed.status !== 'validation_failed') continue;

        if (this._hasValidationExhausted(refreshed)) {
          Todo.update(ft.agent_id, ft.id, {
            status: 'blocked',
            heartbeatStep: `🔒 验证次数已达上限(${this.maxValidationAttempts}次)，需要人工介入`
          });
          Notification.create(ft.agent_id, ft.id, 'validation_exhausted',
            `任务「${ft.title}」验证失败已达 ${this.maxValidationAttempts} 次，已标记为阻塞`
          );
          continue;
        }

        if (this._hasValidationCooldown(refreshed)) continue;

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
