const { getDb } = require('../db');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const Agent = require('../models/Agent');
const JobRunService = require('./JobRunService');
const CommandExecutor = require('./CommandExecutor');
const ProgressValidator = require('./ProgressValidator');
const ValidatorService = require('./ValidatorService');
const ValidationDispatchService = require('./ValidationDispatchService');
const TaskReportService = require('./TaskReportService');
const TaskPlanService = require('./TaskPlanService');
const DataTaskSpecService = require('./DataTaskSpecService');
const { buildDrivePrompt, parseHeartbeatReply } = require('../utils/driveHelper');
const {
  TOOL_DEFINITIONS,
  buildStructuredDrivePrompt,
  executeToolCalls
} = require('../utils/StructuredDriveTools');
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
  toolLoopMaxIterations: 4,
  toolLoopTokenBudget: 12000,
  maxNoProgressRounds: 2,
  maxForcedCronDrivesPerTask: 2,
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
    this.toolLoopMaxIterations = options.toolLoopMaxIterations || DEFAULTS.toolLoopMaxIterations;
    this.toolLoopTokenBudget = options.toolLoopTokenBudget || DEFAULTS.toolLoopTokenBudget;
    this.maxNoProgressRounds = options.maxNoProgressRounds || DEFAULTS.maxNoProgressRounds;
    this.maxForcedCronDrivesPerTask = options.maxForcedCronDrivesPerTask || DEFAULTS.maxForcedCronDrivesPerTask;
    this.drivingTasks = new Set();
    this.toolLoopStats = {
      fallbackReasons: {},
      exitReasons: {}
    };
    this.framework = null;
    this.validator = null;
    this.validationDispatcher = null;
    this._timer = null;
    this._tickRunning = false;
    this._validationTimeouts = new Map();
    this._lastGreetingCount = new Map();
  }

  async consultTask(agentId, taskId, task, question, opts = {}) {
    const llmManager = this.framework?.modules?.llmManager;
    if (!llmManager || !llmManager.hasProvider || !llmManager.hasProvider()) {
      return null;
    }

    const dedupeMinutes = opts.dedupeMinutes ?? 30;
    try {
      const db = getDb();
      const last = db.prepare(`
        SELECT created_at FROM contexts
        WHERE agent_id = ? AND session_id = 'consult-auto'
          AND metadata LIKE ?
        ORDER BY created_at DESC LIMIT 1
      `).get(agentId, `%"task_id":"${taskId}"%`);
      if (last && last.created_at) {
        const lastMs = new Date(last.created_at.replace(' ', 'T') + 'Z').getTime();
        if (Date.now() - lastMs < dedupeMinutes * 60 * 1000) {
          return { skipped: true };
        }
      }
    } catch (e) {}

    const report = await TaskReportService.generateReport(agentId, taskId);
    const prompt = TaskReportService.buildConsultPrompt(task, report, question, {
      maxAttempts: 3,
      maxTimeline: 5,
      maxCommands: 3
    });

    const result = await llmManager.chat({
      messages: [{ role: 'user', content: prompt }],
      system: '你是一个排障助手，只返回 JSON，不要输出任何额外文字。',
      maxTokens: 1200
    });

    const reply = result.content || '';
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    let parsed = null;
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (e) {}
    }

    await Context.create(agentId, {
      sessionId: 'consult-auto',
      role: 'system',
      content: `[ConsultAuto] task=${taskId}\nquestion=${(question || '').slice(0, 200)}\nreply=${reply.slice(0, 1600)}`,
      metadata: { type: 'consult_auto', task_id: taskId }
    });
    Context.pruneBySession(agentId, 'consult-auto', 50);

    const summary = parsed?.summary ? String(parsed.summary).slice(0, 160) : reply.slice(0, 160);
    Notification.create(agentId, taskId, 'comment', `🧠 排障建议：${summary}`);

    return { reply, parsed };
  }

  _createAutoHealingTask(agentId, parentId, fixSteps) {
    if (!fixSteps || fixSteps.length === 0) return;
    
    const stepsText = fixSteps.map((step, i) => `${i + 1}. ${step}`).join('\n');
    const description = `[Auto-Healing] 此任务由系统自动创建，用于解决父任务的阻塞问题。\n\n需要执行的修复步骤:\n${stepsText}\n\n请按顺序执行这些步骤。完成后请结束任务。`;
    
    const childTask = Todo.create(agentId, {
      title: `[修复] 自动修复任务 for ${parentId.split('-')[0]}`,
      description: description,
      status: 'pending',
      priority: 'critical',
      parentId: parentId,
      assignedAgentId: agentId
    });

    console.log(`[DriveOrchestrator] 自动创建修复子任务: ${childTask.id}`);
    
    FocusState.createOrUpdate(agentId, { currentTaskId: childTask.id, focusMode: 'auto' });

    Context.create(agentId, {
      sessionId: 'auto-healing',
      role: 'system',
      content: `[Auto-Healing] 已根据诊断报告自动创建修复任务: ${childTask.id}`,
      metadata: { type: 'auto_healing_created', parent_id: parentId, child_id: childTask.id }
    });
    
    Notification.create(agentId, parentId, 'info', `🛠️ 已自动创建修复任务并切换焦点`);
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
      duckdbMatches.slice(0, 2).forEach((path) => {
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
      TaskPlanService.syncTaskExecution(agentId, Todo.findById(agentId, taskId) || task);
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
    if (task.validation_deadline && /延期|等待下次调度/.test(task.heartbeat_step || '')) {
      const deadline = new Date(task.validation_deadline).getTime();
      if (Number.isFinite(deadline) && Date.now() < deadline) return false;
    }
    if (this.drivingTasks.has(task.id)) return false;
    if (task.is_template) return false;
    if (task.archived) return false;
    const currentAttempts = task.attempt_count || 0;
    const maxAttempts = task.max_attempts || 3;
    if (currentAttempts >= maxAttempts) return false;
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
    const currentAttempts = task.attempt_count || 0;
    const maxAttempts = task.max_attempts || 3;
    if (currentAttempts >= maxAttempts) {
      await this._markAttemptExhausted(task.agent_id, task, 'prepare_task_state');
      return null;
    }
    if (task.status === 'pending') {
      Todo.updateStatus(task.agent_id, task.id, 'in_progress');
      return Todo.findById(task.agent_id, task.id);
    }
    if (task.status === 'blocked') {
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

  buildRetryContext(results, attempt, validationFeedback) {
    const baseMsg = `任务执行遇到问题，正在进行第 ${attempt + 1} 次重试...`;
    const progressMsg = results?.length > 0 ? `\n\n📊 上次执行结果:\n${CommandExecutor.buildExecutionSummary(results)}` : '';
    const validationMsg = validationFeedback ? `\n\n📋 上次验证失败反馈（请务必解决）:\n${validationFeedback}` : '';
    return `${baseMsg}${progressMsg}${validationMsg}`;
  }

  async _runOfficialExecution(agentId, task) {
    Todo.archiveSiblingActiveInstances(agentId, task.id, {
      reason: '正式脚本执行前自动清理同模板旧实例'
    });

    const execution = DataTaskSpecService.getOfficialExecution(task, {
      env: {
        TODO_TASK_ID: task.id,
        TODO_AGENT_ID: agentId
      }
    });
    if (!execution?.command) return null;

    const commands = [{ index: 0, command: execution.command, source: 'official_script' }];
    const results = await CommandExecutor.executeCommands(commands, {
      timeoutMs: execution.timeoutMs || 300000,
      cwd: execution.cwd || process.env.HOME,
      maxCommands: 1
    });

    await Context.create(agentId, {
      sessionId: 'drive-orchestrator',
      role: 'system',
      content: `[DriveOrchestrator] 正式脚本执行结果:\n${CommandExecutor.buildExecutionSummary(results)}`,
      metadata: { type: 'official_execution', task_id: task.id, script_path: execution.scriptPath }
    });

    const attemptSummary = CommandExecutor.summarizeAttemptFromResults(results);
    Todo.recordAttempt(agentId, task.id, {
      success: attemptSummary.success,
      reason: attemptSummary.reason,
      output: attemptSummary.output
    });

    if (!attemptSummary.success) {
      const bucket = attemptSummary.blockers && attemptSummary.blockers.length > 0 ? 'env_missing' : 'tool_failure';
      JobRunService.markFailure(agentId, Todo.findById(agentId, task.id) || task, bucket, {
        source: 'official_execution',
        blockers: attemptSummary.blockers || [],
        reason: attemptSummary.reason,
        scriptPath: execution.scriptPath
      });
      return {
        success: false,
        attempts: 1,
        officialExecution: true,
        commands: results,
        blocked: bucket === 'env_missing',
        blockers: attemptSummary.blockers || []
      };
    }

    const stepLabel = execution.scriptPath ? `🚀 已执行正式脚本: ${execution.scriptPath}` : '🚀 已执行正式脚本';
    Todo.update(agentId, task.id, {
      heartbeatProgress: 100,
      heartbeatStep: stepLabel,
      status: 'pending_validation',
      completionReport: JSON.stringify({
        summary: '已执行正式脚本，进入规则验收',
        executionMode: 'official_script',
        scriptPath: execution.scriptPath,
        updatedAt: new Date().toISOString()
      })
    });
    JobRunService.markPendingValidation(agentId, Todo.findById(agentId, task.id) || task, {
      source: 'official_execution',
      scriptPath: execution.scriptPath
    });

    const validationResult = await this.validator.validateTask(agentId, Todo.findById(agentId, task.id) || task);
    const latest = Todo.findById(agentId, task.id) || task;
    if (validationResult.pass) {
      JobRunService.markValidated(agentId, latest, true, {
        source: 'official_execution'
      });
    } else if (!validationResult.deferred) {
      JobRunService.markValidated(agentId, latest, false, {
        source: 'official_execution',
        reason: validationResult.reason
      });
    }

    return {
      success: validationResult.pass,
      attempts: 1,
      officialExecution: true,
      validationTriggered: true,
      deferred: Boolean(validationResult.deferred),
      commands: results,
      validator: validationResult.validator,
      reason: validationResult.reason
    };
  }

  _extractUsageTokens(usage) {
    if (!usage) return 0;
    return usage.totalTokens || usage.total_tokens || usage.promptTokens || usage.prompt_tokens || 0;
  }

  _recordToolLoopStat(bucket, key) {
    if (!key) return;
    if (!this.toolLoopStats[bucket]) {
      this.toolLoopStats[bucket] = {};
    }
    this.toolLoopStats[bucket][key] = (this.toolLoopStats[bucket][key] || 0) + 1;
  }

  getToolLoopStats() {
    return JSON.parse(JSON.stringify(this.toolLoopStats));
  }

  resetToolLoopStats() {
    this.toolLoopStats = {
      fallbackReasons: {},
      exitReasons: {}
    };
  }

  async _markAttemptExhausted(agentId, task, reason = 'attempt_limit_exhausted') {
    if (!task) return null;
    const currentAttempts = task.attempt_count || 0;
    const maxAttempts = task.max_attempts || 3;
    const latest = Todo.findById(agentId, task.id) || task;

    if (latest.status !== 'blocked') {
      Todo.update(agentId, task.id, {
        status: 'blocked',
        heartbeatStep: `🔒 尝试次数已达上限(${currentAttempts}/${maxAttempts})，停止自动驱动，等待人工介入`
      });
    }

    await Context.create(agentId, {
      sessionId: 'drive-orchestrator',
      role: 'system',
      content: `[DriveOrchestrator] 任务「${task.title}」已达到最大尝试次数，拒绝继续自动驱动`,
      metadata: {
        type: 'attempt_limit_exhausted',
        task_id: task.id,
        reason,
        attempt_count: currentAttempts,
        max_attempts: maxAttempts
      }
    });
    Notification.create(agentId, task.id, 'max_attempts',
      `任务「${task.title}」已达到最大尝试次数（${currentAttempts}/${maxAttempts}），已停止自动驱动`
    );

    return Todo.findById(agentId, task.id);
  }

  _countForcedDriveAttempts(agentId, taskId, source) {
    const db = getDb();
    const params = [
      agentId,
      '%"type":"forced_drive_request"%',
      `%"task_id":"${taskId}"%`
    ];
    let sql = `
      SELECT COUNT(*) AS count
      FROM contexts
      WHERE agent_id = ?
        AND session_id = 'drive-orchestrator'
        AND metadata LIKE ?
        AND metadata LIKE ?
    `;

    if (source) {
      sql += ' AND metadata LIKE ?';
      params.push(`%"source":"${source}"%`);
    }

    return db.prepare(sql).get(...params).count || 0;
  }

  async triggerTaskDrive(agentId, taskOrId, options = {}) {
    const {
      reason = 'forced_drive',
      source = 'system',
      allowPendingChildren = false,
      maxForcedAttempts = this.maxForcedCronDrivesPerTask,
      waitForCompletion = false,
      setFocus = true
    } = options;

    if (!this.framework?.modules?.llmManager) {
      return { queued: false, reason: 'framework_unavailable' };
    }

    const taskId = typeof taskOrId === 'string' ? taskOrId : taskOrId?.id;
    const freshTask = taskId ? Todo.findById(agentId, taskId) : null;
    if (!freshTask) {
      return { queued: false, reason: 'task_not_found' };
    }
    const currentAttempts = freshTask.attempt_count || 0;
    const maxAttempts = freshTask.max_attempts || 3;
    if (currentAttempts >= maxAttempts) {
      await this._markAttemptExhausted(agentId, freshTask, 'trigger_task_drive');
      return { queued: false, reason: 'attempt_limit_exhausted', attemptCount: currentAttempts, maxAttempts };
    }
    if (freshTask.is_template || freshTask.archived) {
      return { queued: false, reason: 'task_not_drivable' };
    }
    if (['completed', 'cancelled', 'validating'].includes(freshTask.status)) {
      return { queued: false, reason: 'task_not_drivable' };
    }
    if (this.drivingTasks.has(freshTask.id)) {
      return { queued: false, reason: 'already_driving' };
    }

    const isForcedPendingChild = allowPendingChildren && freshTask.status === 'pending' && freshTask.parent_id;
    if (!this.shouldDrive(freshTask) && !isForcedPendingChild) {
      return { queued: false, reason: 'should_drive_rejected' };
    }

    const forcedAttemptCount = this._countForcedDriveAttempts(agentId, freshTask.id, source);
    if (forcedAttemptCount >= maxForcedAttempts) {
      return { queued: false, reason: 'forced_attempt_limit_reached', forcedAttemptCount };
    }

    if (setFocus) {
      try {
        FocusState.createOrUpdate(agentId, { currentTaskId: freshTask.id, focusMode: 'auto' });
      } catch (focusErr) {
        console.warn(`[DriveOrchestrator] triggerTaskDrive focus update failed: ${focusErr.message}`);
      }
    }

    await Context.create(agentId, {
      sessionId: 'drive-orchestrator',
      role: 'system',
      content: `[ForcedDrive] source=${source} reason=${reason} task=${freshTask.id} attempt=${forcedAttemptCount + 1}/${maxForcedAttempts}`,
      metadata: {
        type: 'forced_drive_request',
        task_id: freshTask.id,
        source,
        reason,
        forced_attempt: forcedAttemptCount + 1,
        max_forced_attempts: maxForcedAttempts
      }
    });
    JobRunService.appendSchedulerEvent(agentId, 'forced_drive_requested', {
      templateId: freshTask.parent_id || null,
      taskId: freshTask.id,
      eventStatus: 'info',
      details: { source, reason, forced_attempt: forcedAttemptCount + 1 }
    });

    const runner = async () => {
      this.drivingTasks.add(freshTask.id);
      try {
        JobRunService.markDriveStarted(agentId, freshTask, { source, reason, mode: 'forced' });
        const result = await this.driveTask(agentId, Todo.findById(agentId, freshTask.id) || freshTask);
        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'system',
          content: `[ForcedDrive] source=${source} task=${freshTask.id} completed=${!!result?.success} blocked=${!!result?.blocked} stalled=${!!result?.stalled}`,
          metadata: {
            type: 'forced_drive_result',
            task_id: freshTask.id,
            source,
            reason,
            success: !!result?.success,
            blocked: !!result?.blocked,
            stalled: !!result?.stalled,
            validation_triggered: !!result?.validationTriggered
          }
        });
        if (result?.blocked) {
          JobRunService.markFailure(agentId, Todo.findById(agentId, freshTask.id) || freshTask, 'tool_failure', {
            source,
            reason,
            mode: 'forced'
          });
        }
        return result;
      } finally {
        this.drivingTasks.delete(freshTask.id);
      }
    };

    if (waitForCompletion) {
      const result = await runner();
      return { queued: true, started: true, result };
    }

    runner().catch(async (err) => {
      try {
        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'system',
          content: `[ForcedDrive] source=${source} task=${freshTask.id} error=${err.message}`,
          metadata: {
            type: 'forced_drive_error',
            task_id: freshTask.id,
            source,
            reason,
            error: err.message
          }
        });
      } catch (contextErr) {
        console.error('[DriveOrchestrator] forced drive context write failed:', contextErr.message);
      }
      console.error(`[DriveOrchestrator] forced drive failed for ${freshTask.id}:`, err.message);
    });

    return { queued: true, started: true, forcedAttemptCount: forcedAttemptCount + 1 };
  }

  _buildToolLoopMessages(task, retryContext) {
    const prompt = buildStructuredDrivePrompt(task, { isManual: false });
    const userContent = retryContext
      ? `${prompt}\n\n## 上次执行上下文\n${retryContext}`
      : prompt;

    return [
      {
        role: 'system',
        content: '你是 TODO Server 的自动执行引擎。你的目标不是汇报计划，而是通过工具真正推进任务。每轮优先调用工具；有进展就更新进度；满足验收条件就调用 proposeCompletion；无法继续时调用 askForHelp。'
      },
      {
        role: 'user',
        content: userContent
      }
    ];
  }

  _summarizeStructuredToolResults(toolResults) {
    if (!toolResults || toolResults.length === 0) return '(无结构化工具调用)';
    return toolResults.map(({ toolCall, result }) => {
      const toolName = toolCall?.function?.name || 'unknown';
      const status = result?.success ? '✅' : '❌';
      const action = result?.action || 'unknown';
      const dataText = result?.data ? JSON.stringify(result.data).slice(0, 240) : (result?.error || '');
      return `${status} ${toolName} -> ${action}\n${dataText}`;
    }).join('\n---\n');
  }

  async _recordToolLoopFallback(agentId, task, reason, details = {}) {
    this._recordToolLoopStat('fallbackReasons', reason || 'unknown');
    await Context.create(agentId, {
      sessionId: 'drive-orchestrator',
      role: 'system',
      content: `[DriveOrchestrator] 结构化工具链回退到 legacy 流程，原因：${reason || 'unknown'}`,
      metadata: { type: 'tool_loop_fallback', task_id: task.id, reason: reason || 'unknown', ...details }
    });
  }

  async _recordToolLoopExit(agentId, task, reason, details = {}) {
    this._recordToolLoopStat('exitReasons', reason || 'unknown');
    await Context.create(agentId, {
      sessionId: 'drive-orchestrator',
      role: 'system',
      content: `[DriveOrchestrator][tool-loop] 退出原因：${reason || 'unknown'}`,
      metadata: { type: 'tool_loop_exit', task_id: task.id, reason: reason || 'unknown', ...details }
    });
  }

  async _markTaskBlocked(agentId, task, blockers, reasonPrefix, contextType = 'env_blocked') {
    const latest = Todo.findById(agentId, task.id) || task;
    const mergedBlockers = [...new Set([...(latest.heartbeat_blockers || []), ...(blockers || [])])];
    const blockerText = mergedBlockers.join('；');

    Todo.update(agentId, task.id, {
      status: 'blocked',
      failureBucket: contextType === 'env_blocked' ? 'env_missing' : 'human_blocked',
      heartbeatStep: `⛔ ${reasonPrefix}：${blockerText}`,
      heartbeatBlockers: mergedBlockers
    });
    JobRunService.markFailure(agentId, Todo.findById(agentId, task.id) || task, contextType === 'env_blocked' ? 'env_missing' : 'human_blocked', {
      reasonPrefix,
      blockers: mergedBlockers,
      contextType
    });

    Context.create(agentId, {
      sessionId: task.id,
      role: 'system',
      content: `[${reasonPrefix}] 任务已阻塞：${blockerText}`,
      metadata: { type: contextType, task_id: task.id, blockers: mergedBlockers }
    });

    Notification.create(agentId, task.id, 'blocked',
      `任务「${task.title}」${reasonPrefix}：${blockerText}`
    );

    try {
      const blockedTask = Todo.findById(agentId, task.id);
      const localPlan = this._buildDeterministicHealingPlan(blockedTask, mergedBlockers, reasonPrefix);
      if (localPlan.fix_steps.length > 0) {
        this._createAutoHealingTask(agentId, task.id, localPlan.fix_steps);
      } else {
        const consultRes = await this.consultTask(agentId, task.id, blockedTask, `任务因「${reasonPrefix}」被阻塞。请给出最小修复步骤与需要补齐的环境/目录/依赖清单。`);
        if (consultRes && consultRes.parsed && Array.isArray(consultRes.parsed.fix_steps) && consultRes.parsed.fix_steps.length > 0) {
          this._createAutoHealingTask(agentId, task.id, consultRes.parsed.fix_steps);
        }
      }
    } catch (e) {
      console.error('[DriveOrchestrator] 自动排障失败:', e.message);
    }
  }

  _buildDeterministicHealingPlan(task, blockers = [], reasonPrefix = '') {
    const lowerText = `${reasonPrefix}\n${(blockers || []).join('\n')}\n${task?.description || ''}`.toLowerCase();
    const fixSteps = [];
    const checklist = [];

    if (/目录不存在|path not found|no such file or directory|不存在/.test(lowerText)) {
      fixSteps.push('检查任务依赖的目录或文件路径是否存在，缺失则先创建目录并补齐输入文件。');
      checklist.push('目录路径', '输入文件');
    }
    if (/环境变量|env|未设置/.test(lowerText)) {
      fixSteps.push('检查任务依赖的环境变量配置，补齐 .env 或运行时变量后重新执行。');
      checklist.push('环境变量');
    }
    if (/python|脚本|script not found|module not found/.test(lowerText)) {
      fixSteps.push('确认 Python 脚本路径和依赖包是否可用，必要时安装缺失依赖并执行一次 --help 或最小验证命令。');
      checklist.push('Python 依赖', '脚本路径');
    }
    if (/command not found|not found/.test(lowerText)) {
      fixSteps.push('检查任务依赖的可执行命令是否已安装并在 PATH 中可见。');
      checklist.push('系统命令');
    }
    if (/权限|permission denied/.test(lowerText)) {
      fixSteps.push('检查目标目录和脚本的读写执行权限，补齐权限后再重试。');
      checklist.push('目录权限', '脚本权限');
    }

    if (fixSteps.length === 0 && blockers.length > 0) {
      fixSteps.push(`逐项核对阻塞信息并补齐依赖：${blockers.join('；')}`);
    }

    return {
      summary: fixSteps.length > 0 ? '规则引擎已生成最小修复步骤' : '暂无确定性规则修复路径',
      fix_steps: [...new Set(fixSteps)],
      preflight_checklist: [...new Set(checklist)]
    };
  }

  async _handleStructuredToolResults(agentId, task, toolResults) {
    for (const { toolCall, result } of (toolResults || [])) {
      const toolName = toolCall?.function?.name || 'unknown';
      const data = result?.data || {};

      if (toolName === 'executeCommand') {
        Todo.recordAttempt(agentId, task.id, {
          success: !!result?.success,
          reason: result?.success
            ? `结构化执行成功: ${data.command || ''}`.trim()
            : `结构化执行失败: ${data.command || ''}`.trim(),
          output: String(data.output || result?.error || '').slice(0, 1200)
        });

        const blockers = Array.isArray(data.blockers) ? data.blockers : [];
        if (!result?.success && blockers.length > 0) {
          await this._markTaskBlocked(agentId, task, blockers, '结构化执行阻塞');
          return { handled: true, blocked: true, blockers };
        }
      }

      if (result?.action === 'task_pending_validation') {
        return { handled: true, success: true, validationTriggered: true };
      }

      if (result?.action === 'task_force_completed') {
        return { handled: true, success: true, forceCompleted: true };
      }

      if (result?.action === 'help_requested') {
        return { handled: true, blocked: true, helpRequested: true };
      }
    }

    return { handled: false };
  }

  async runToolDrivenLoop(agentId, task, retryContext = null) {
    const llmManager = this.framework?.modules?.llmManager;
    if (!llmManager || !llmManager.hasProvider || !llmManager.hasProvider()) {
      return { fallback: true, reason: 'llm_unavailable', totalTokens: 0, iterations: 0 };
    }

    const messages = this._buildToolLoopMessages(task, retryContext);
    let totalTokens = 0;
    let noProgressRounds = 0;

    for (let iteration = 0; iteration < this.toolLoopMaxIterations; iteration++) {
      const currentTask = Todo.findById(agentId, task.id) || task;
      const before = ProgressValidator.snapshot(currentTask);
      const remainingBudget = Math.max(1000, this.toolLoopTokenBudget - totalTokens);

      const response = await llmManager.chat({
        messages: [...messages],
        tools: TOOL_DEFINITIONS,
        maxTokens: Math.min(3000, remainingBudget)
      });
      totalTokens += this._extractUsageTokens(response.usage);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'assistant',
          content: `[DriveOrchestrator][tool-loop] 未返回工具调用，第 ${iteration + 1} 轮：\n${String(response.content || '').slice(0, 500)}`,
          metadata: { type: 'tool_loop_no_tool_calls', task_id: task.id, iteration: iteration + 1 }
        });
        return {
          fallback: true,
          reason: 'no_tool_calls',
          attempts: iteration + 1,
          reply: response.content || '',
          totalTokens,
          iterations: iteration + 1
        };
      }

      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.toolCalls
      });

      const toolResults = await executeToolCalls(response.toolCalls, agentId, task.id, 'drive-orchestrator');
      for (const { toolCall, result } of toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: `[DriveOrchestrator][tool-loop] 第 ${iteration + 1} 轮工具结果\n${this._summarizeStructuredToolResults(toolResults)}`,
        metadata: { type: 'tool_loop_results', task_id: task.id, iteration: iteration + 1, tool_count: toolResults.length }
      });

      const handled = await this._handleStructuredToolResults(agentId, task, toolResults);
      const refreshed = Todo.findById(agentId, task.id) || currentTask;
      const after = ProgressValidator.snapshot(refreshed);
      const changed = ProgressValidator.compare(before, after).changed;

      if (!changed) {
        noProgressRounds++;
      } else {
        noProgressRounds = 0;
      }

      if (handled.handled) {
        await this._recordToolLoopExit(agentId, task, handled.validationTriggered
          ? 'pending_validation'
          : handled.forceCompleted
            ? 'force_completed'
            : handled.helpRequested
              ? 'help_requested'
              : handled.blocked
                ? 'blocked'
                : 'handled', {
          iteration: iteration + 1,
          total_tokens: totalTokens
        });
        return {
          ...handled,
          attempts: iteration + 1,
          toolLoop: true,
          totalTokens
        };
      }

      if (refreshed.status === 'pending_validation') {
        await this._recordToolLoopExit(agentId, task, 'pending_validation', {
          iteration: iteration + 1,
          total_tokens: totalTokens
        });
        return { success: true, validationTriggered: true, attempts: iteration + 1, toolLoop: true, totalTokens };
      }

      if (refreshed.status === 'completed') {
        await this._recordToolLoopExit(agentId, task, 'completed', {
          iteration: iteration + 1,
          total_tokens: totalTokens
        });
        return { success: true, attempts: iteration + 1, toolLoop: true, totalTokens };
      }

      if (refreshed.status === 'blocked') {
        await this._recordToolLoopExit(agentId, task, 'blocked', {
          iteration: iteration + 1,
          total_tokens: totalTokens
        });
        return { blocked: true, attempts: iteration + 1, toolLoop: true, totalTokens };
      }

      if (noProgressRounds >= this.maxNoProgressRounds || totalTokens >= this.toolLoopTokenBudget) {
        const fallbackReason = noProgressRounds >= this.maxNoProgressRounds ? 'no_progress' : 'token_budget_exceeded';
        await this._recordToolLoopExit(agentId, task, fallbackReason, {
          iteration: iteration + 1,
          total_tokens: totalTokens,
          no_progress_rounds: noProgressRounds,
          token_budget: this.toolLoopTokenBudget
        });
        return {
          fallback: true,
          reason: fallbackReason,
          attempts: iteration + 1,
          toolLoop: true,
          totalTokens,
          iterations: iteration + 1,
          noProgressRounds
        };
      }
    }

    await this._recordToolLoopExit(agentId, task, 'tool_loop_iteration_limit', {
      iteration: this.toolLoopMaxIterations,
      total_tokens: totalTokens,
      token_budget: this.toolLoopTokenBudget
    });
    return {
      fallback: true,
      reason: 'tool_loop_iteration_limit',
      attempts: this.toolLoopMaxIterations,
      toolLoop: true,
      totalTokens,
      iterations: this.toolLoopMaxIterations
    };
  }

  _mergeRetryContext(planOverlay, retryContext) {
    return [planOverlay, retryContext].filter(Boolean).join('\n\n');
  }

  async driveTask(agentId, task) {
    const planGate = TaskPlanService.ensureExecutablePlan(agentId, task);
    if (planGate.required && !planGate.approved) {
      return {
        success: false,
        blocked: true,
        enforcedPlan: true,
        reason: planGate.reason || 'plan_review_blocked'
      };
    }

    const task_ = await this.prepareTaskState(planGate.task || task);
    if (!task_) return { success: false, attempts: 0, reason: 'prepare_failed' };

    if (planGate.required) {
      const currentStep = TaskPlanService.getCurrentStep(agentId, task_);
      if (currentStep?.step_key === 'inspect') {
        const inspectResult = TaskPlanService.completeInspectStep(agentId, task_);
        return {
          success: true,
          attempts: 0,
          enforcedPlan: true,
          planAdvanced: inspectResult.advanced,
          step: 'inspect'
        };
      }

      if (currentStep?.step_key === 'verify') {
        const synced = TaskPlanService.syncTaskExecution(agentId, task_);
        const latestTask = synced.task || Todo.findById(agentId, task_.id) || task_;
        return {
          success: latestTask.status === 'completed',
          attempts: 0,
          enforcedPlan: true,
          waitingValidation: ['pending_validation', 'validating'].includes(latestTask.status),
          blocked: latestTask.status === 'validation_failed',
          step: 'verify'
        };
      }

      if (currentStep?.step_key === 'execute') {
        const activeStep = TaskPlanService.markExecuteStarted(agentId, task_) || currentStep;
        const planOverlay = TaskPlanService.buildExecutionOverlay(activeStep);
        const result = await this._driveTaskCore(agentId, Todo.findById(agentId, task_.id) || task_, planOverlay);
        const synced = TaskPlanService.syncTaskExecution(agentId, Todo.findById(agentId, task_.id) || task_);
        const latestTask = synced.task || Todo.findById(agentId, task_.id) || task_;
        return {
          ...result,
          enforcedPlan: true,
          step: 'execute',
          planStatus: latestTask.plan_status,
          executionState: latestTask.execution_state
        };
      }
    }

    const result = await this._driveTaskCore(agentId, task_);
    TaskPlanService.syncTaskExecution(agentId, Todo.findById(agentId, task_.id) || task_);
    return result;
  }

  async _driveTaskCore(agentId, task, planOverlay = null) {
    const task_ = task;
    getDb().prepare(`UPDATE todos SET last_driven_at = CURRENT_TIMESTAMP WHERE id = ?`).run(task_.id);
    JobRunService.markDriveStarted(agentId, task_, { source: 'drive_orchestrator', mode: 'auto' });

    const officialExecutionResult = await this._runOfficialExecution(agentId, task_);
    if (officialExecutionResult) {
      return officialExecutionResult;
    }

    let attempt = 0;
    let retryContext = task_._validationFeedback ? `📋 验证失败反馈（请务必解决）:\n${task_._validationFeedback}` : null;
    retryContext = this._mergeRetryContext(planOverlay, retryContext);
    let lastResults = null;
    let lastReply = null;

    try {
      const toolLoopResult = await this.runToolDrivenLoop(agentId, task_, retryContext);
      if (toolLoopResult && !toolLoopResult.fallback) {
        return toolLoopResult;
      }

      await this._recordToolLoopFallback(agentId, task_, toolLoopResult?.reason || 'unknown', {
        total_tokens: toolLoopResult?.totalTokens || 0,
        iterations: toolLoopResult?.iterations || toolLoopResult?.attempts || 0,
        no_progress_rounds: toolLoopResult?.noProgressRounds || 0
      });
    } catch (toolErr) {
      this._recordToolLoopStat('fallbackReasons', 'tool_loop_error');
      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: `[DriveOrchestrator] 结构化工具链异常，回退到 legacy 流程：${toolErr.message}`,
        metadata: { type: 'tool_loop_error', task_id: task_.id, reason: 'tool_loop_error', error: toolErr.message }
      });
    }

    while (attempt < this.maxRetries) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, this.retryBackoffMs[attempt] || 0));
      }

      const preflight = CommandExecutor.preflightFromTask(task_);
      if (preflight && preflight.blockers && preflight.blockers.length > 0) {
        const msg = `Preflight 阻塞：${preflight.blockers.join('；')}`;
        Todo.recordAttempt(agentId, task_.id, {
          success: false,
          reason: 'Preflight 检测到环境缺失',
          output: msg
        });
        const latest = Todo.findById(agentId, task_.id);
        const mergedBlockers = [...new Set([...(latest.heartbeat_blockers || []), ...preflight.blockers])];
        Todo.update(agentId, task_.id, {
          status: 'blocked',
          failureBucket: 'env_missing',
          heartbeatStep: `⛔ Preflight 阻塞：${preflight.blockers.join('；')}`,
          heartbeatBlockers: mergedBlockers
        });
        JobRunService.markFailure(agentId, Todo.findById(agentId, task_.id) || task_, 'env_missing', {
          source: 'preflight',
          blockers: preflight.blockers,
          spec: preflight.spec,
          notes: preflight.notes
        });
        await Context.create(agentId, {
          sessionId: task_.id,
          role: 'system',
          content: `[Preflight] 任务已阻塞：${preflight.blockers.join('；')}`,
          metadata: { type: 'preflight_blocked', task_id: task_.id, blockers: preflight.blockers, spec: preflight.spec, notes: preflight.notes }
        });
        Notification.create(agentId, task_.id, 'blocked',
          `任务「${task_.title}」Preflight 阻塞：${preflight.blockers.join('；')}`
        );
        const localPlan = this._buildDeterministicHealingPlan(Todo.findById(agentId, task_.id) || task_, preflight.blockers, 'Preflight 检测到环境缺失导致阻塞');
        if (localPlan.fix_steps.length > 0) {
          this._createAutoHealingTask(agentId, task_.id, localPlan.fix_steps);
        }
        return { success: false, attempts: attempt + 1, blocked: true, blockers: preflight.blockers, preflight: true };
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
        JobRunService.markFailure(agentId, Todo.findById(agentId, task_.id) || task_, 'llm_unstable', {
          source: 'drive_orchestrator',
          attempt: attempt + 1,
          error: llmErr.message
        });
        attempt++;
        retryContext = this._mergeRetryContext(
          planOverlay,
          `【自动重试 #${attempt + 1}】LLM 调用失败: ${llmErr.message}`
        );
        continue;
      }

      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'assistant',
        content: `[DriveOrchestrator] LLM 回复 attempt=${attempt + 1}:\n${reply.substring(0, 500)}`,
        metadata: { type: 'llm_reply', task_id: task_.id, reply_length: reply.length },
      });

      const isGreetingLoop = this.detectGreetingLoop(reply, task_);

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

        const attemptSummary = CommandExecutor.summarizeAttemptFromResults(execResults);
        Todo.recordAttempt(agentId, task_.id, {
          success: attemptSummary.success,
          reason: attemptSummary.reason,
          output: attemptSummary.output
        });
        if (!attemptSummary.success) {
          const bucket = attemptSummary.blockers && attemptSummary.blockers.length > 0 ? 'env_missing' : 'tool_failure';
          JobRunService.markFailure(agentId, Todo.findById(agentId, task_.id) || task_, bucket, {
            source: 'command_execution',
            blockers: attemptSummary.blockers || [],
            reason: attemptSummary.reason
          });
        }

        if (!attemptSummary.success && attemptSummary.blockers && attemptSummary.blockers.length > 0) {
          const latest = Todo.findById(agentId, task_.id);
          const mergedBlockers = [...new Set([...(latest.heartbeat_blockers || []), ...attemptSummary.blockers])];
          Todo.update(agentId, task_.id, {
            status: 'blocked',
            failureBucket: 'env_missing',
            heartbeatStep: `⛔ 环境缺失/阻塞：${attemptSummary.blockers.join('；')}`,
            heartbeatBlockers: mergedBlockers
          });

          Context.create(agentId, {
            sessionId: task_.id,
            role: 'system',
            content: `[AutoPreflight] 检测到环境缺失，任务已标记为 blocked：${attemptSummary.blockers.join('；')}`,
            metadata: { type: 'env_blocked', task_id: task_.id, blockers: attemptSummary.blockers }
          });

          Notification.create(agentId, task_.id, 'blocked',
            `任务「${task_.title}」环境缺失，已阻塞：${attemptSummary.blockers.join('；')}`
          );

          const localPlan = this._buildDeterministicHealingPlan(Todo.findById(agentId, task_.id) || task_, attemptSummary.blockers, '任务已被环境缺失阻塞');
          if (localPlan.fix_steps.length > 0) {
            this._createAutoHealingTask(agentId, task_.id, localPlan.fix_steps);
          }

          return { success: false, attempts: attempt + 1, reply, commands: execResults, blocked: true, blockers: attemptSummary.blockers };
        }
      }

      const parsed = parseHeartbeatReply(task_, reply);
      if (parsed.changed) {
        Todo.updateHeartbeat(agentId, task_.id, {
          progress: parsed.progress,
          step: parsed.step,
          blockers: parsed.blockers,
        });
      }

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
            JobRunService.markCompleted(agentId, Todo.findById(agentId, task_.id) || refreshedForValidation, {
              source: 'validation_task_auto_complete'
            });
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
            JobRunService.markPendingValidation(agentId, Todo.findById(agentId, task_.id) || refreshedForValidation, {
              source: 'drive_progress_100'
            });
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
            JobRunService.markPendingValidation(agentId, Todo.findById(agentId, task_.id) || freshTask, {
              source: 'drive_validation_fallback'
            });
            return { success: true, validationTriggered: true, attempts: attempt + 1, changed: false };
          }
        }
      }

      lastReply = reply;
      lastResults = execResults;

      if (attempt + 1 < this.maxRetries) {
        retryContext = this._mergeRetryContext(
          planOverlay,
          this.buildRetryContext(lastResults, attempt, task_._validationFeedback || null)
        );
      }
      attempt++;
    }

    Notification.create(agentId, task_.id, 'stalled',
      `⚠️ 任务「${task_.title}」执行多次无进展，请人工介入检查`
    );

    Todo.update(agentId, task_.id, {
      failureBucket: 'tool_failure',
      heartbeatStep: '⚠️ 等待人工介入',
    });
    JobRunService.markFailure(agentId, Todo.findById(agentId, task_.id) || task_, 'tool_failure', {
      source: 'drive_orchestrator',
      reason: 'stalled_after_retries'
    });

    try {
      const stalledTask = Todo.findById(agentId, task_.id);
      const consultRes = await this.consultTask(agentId, task_.id, stalledTask, '任务多轮驱动无进展。请基于执行记录推断卡点并给出下一步排障与修复路径（优先给最小变更方案）。');
      if (consultRes && consultRes.parsed && Array.isArray(consultRes.parsed.fix_steps) && consultRes.parsed.fix_steps.length > 0) {
        this._createAutoHealingTask(agentId, task_.id, consultRes.parsed.fix_steps);
      }
    } catch (e) {
      console.error('[DriveOrchestrator] Stalled Auto-Healing 失败:', e.message);
    }

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

    // 检查是否有完成的自动修复子任务，恢复其父任务
    try {
      const completedHealingTasks = db.prepare(`
        SELECT id, parent_id, agent_id, title FROM todos
        WHERE status = 'completed'
          AND parent_id IS NOT NULL AND parent_id != ''
          AND title LIKE '[修复]%'
      `).all();

      for (const child of completedHealingTasks) {
        const parent = Todo.findById(child.agent_id, child.parent_id);
        if (parent && parent.status === 'blocked') {
          Todo.update(parent.agent_id, parent.id, {
            status: 'pending',
            heartbeatStep: `🔄 子任务「${child.title}」已完成，恢复父任务执行`,
            attemptCount: 0
          });
          Context.create(parent.agent_id, {
            sessionId: 'auto-healing',
            role: 'system',
            content: `[Auto-Healing] 子任务 ${child.id} 已完成，父任务恢复为 pending 状态。`,
            metadata: { type: 'auto_healing_resume', child_id: child.id, parent_id: parent.id }
          });
          Notification.create(parent.agent_id, parent.id, 'info', `🔄 自动修复完成，已恢复任务执行`);
        }
        // 将子任务标记为已归档，避免重复处理
        Todo.update(child.agent_id, child.id, { archived: 1 });
      }
    } catch (e) {
      console.error('[DriveOrchestrator] 恢复父任务失败:', e.message);
    }

    const agents = Agent.findAll();
    let totalDriven = 0;
    let totalStalled = 0;
    let concurrent = 0;

    for (const agent of agents) {
      if (concurrent >= this.maxConcurrentDrives) break;

      const focus = FocusState.findByAgent(agent.id);
      let task = focus && focus.current_task_id ? Todo.findById(agent.id, focus.current_task_id) : null;

      if (!task || !this.shouldDrive(task)) {
        try {
          const newFocus = await FocusState.autoFocus(agent.id, this.framework?.modules?.llmManager);
          if (newFocus) {
            task = Todo.findById(agent.id, newFocus.id);
          }
        } catch (e) {
          console.error(`[DriveOrchestrator] 自动聚焦失败:`, e.message);
        }
      }

      if (!task || !this.shouldDrive(task)) continue;

      if (task.status === 'pending') {
        const concurrency = Agent.canAcceptNewTask(agent.id);
        if (!concurrency.canAccept) {
          continue;
        }
      }

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
              JobRunService.markValidated(pv.agent_id, Todo.findById(pv.agent_id, pv.id) || pv, true, {
                source: 'validator_service'
              });
              totalDriven++;
            } else {
              const refreshed = Todo.findById(pv.agent_id, pv.id);
              if (this._hasValidationExhausted(refreshed)) {
                Todo.update(pv.agent_id, pv.id, {
                  status: 'blocked',
                  failureBucket: 'validation_failed',
                  heartbeatStep: `🔒 验证次数已达上限(${this.maxValidationAttempts}次)，需要人工介入`
                });
                Notification.create(pv.agent_id, pv.id, 'validation_exhausted',
                  `任务「${pv.title}」验证失败已达 ${this.maxValidationAttempts} 次，已标记为阻塞`
                );
                JobRunService.markValidated(pv.agent_id, Todo.findById(pv.agent_id, pv.id) || refreshed || pv, false, {
                  source: 'validator_service',
                  exhausted: true
                });
              } else {
                Todo.updateStatus(pv.agent_id, pv.id, 'validation_failed');
                JobRunService.markValidated(pv.agent_id, Todo.findById(pv.agent_id, pv.id) || refreshed || pv, false, {
                  source: 'validator_service'
                });
              }
              totalStalled++;
            }
            TaskPlanService.syncTaskExecution(pv.agent_id, Todo.findById(pv.agent_id, pv.id) || pv);
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

    if (concurrent < this.maxConcurrentDrives) {
      const limit = Math.max(0, this.maxConcurrentDrives - concurrent);
      const unassignedTasks = db.prepare(`
        SELECT * FROM todos
        WHERE status = 'pending'
          AND (assigned_agent_id IS NULL OR assigned_agent_id = '')
          AND is_template = 0
          AND archived = 0
          AND (parent_id IS NULL OR parent_id = '')
        ORDER BY
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          created_at ASC
        LIMIT ?
      `).all(limit * 3);

      for (const ut of unassignedTasks) {
        if (concurrent >= this.maxConcurrentDrives) break;

        let assignedAgent = null;
        for (const agent of agents) {
          const concurrency = Agent.canAcceptNewTask(agent.id);
          if (concurrency.canAccept) {
            assignedAgent = agent;
            break;
          }
        }

        if (assignedAgent) {
          db.prepare(`UPDATE todos SET assigned_agent_id = ?, updated_at = datetime('now') WHERE id = ?`).run(assignedAgent.id, ut.id);
          FocusState.setIfNone(assignedAgent.id, ut.id);
          console.log(`[DriveOrchestrator] 自动分配未归属任务「${ut.title}」到 Agent ${assignedAgent.id}`);
          Notification.create(assignedAgent.id, ut.id, 'assigned',
            `任务「${ut.title}」已自动分配给 Agent ${assignedAgent.id}`
          );
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
