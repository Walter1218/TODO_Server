require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const logger = require('./utils/logger');
const agentsRouter = require('./routes/agents');
const todosRouter = require('./routes/todos');
const projectsRouter = require('./routes/projects');
const focusRouter = require('./routes/focus');
const contextsRouter = require('./routes/contexts');
const notificationsRouter = require('./routes/notifications');
const llmRouter = require('./routes/llm');
const Agent = require('./models/Agent');
const Todo = require('./models/Todo');
const Notification = require('./models/Notification');
const Context = require('./models/Context');
const FocusState = require('./models/FocusState');
const JobRunService = require('./services/JobRunService');
const TemplatePreflightService = require('./services/TemplatePreflightService');
const ScheduleGovernanceService = require('./services/ScheduleGovernanceService');
const OpsBackfillService = require('./services/OpsBackfillService');
const { getDb } = require('./db');
const { isValidationTask, getTaskTypeLabel, getTaskBehavior, TaskType } = require('./utils/TaskType');

const app = express();
const PORT = process.env.PORT || 3000;

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').trim();
  return ip === '127.0.0.1'
    || ip === '::1'
    || ip === '::ffff:127.0.0.1'
    || forwardedFor === '127.0.0.1'
    || forwardedFor === '::1'
    || forwardedFor.startsWith('127.0.0.1,');
}

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!require('fs').existsSync(logsDir)) {
  require('fs').mkdirSync(logsDir, { recursive: true });
}

// CORS Configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.CORS_ORIGIN || false) // 在生产环境中，如果没有配置 CORS_ORIGIN 则禁用跨域，或者填入具体的域名白名单
    : '*', // 开发环境允许所有跨域
};
app.use(cors(corsOptions));
app.use(express.json());

// Trust proxy for rate limiting behind Nginx
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// API Rate Limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 1000 : 10000, // Limit each IP to 1000 requests per `window` in prod
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Apply rate limiter to all API routes
app.use('/api', (req, res, next) => {
  if (isLocalRequest(req) && process.env.DISABLE_LOCAL_DASHBOARD_BYPASS !== '1') {
    return next();
  }
  return apiLimiter(req, res, next);
});

app.use((req, res, next) => {
  logger.info(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Auth middleware: verify X-Agent-Secret header matches agent's secret_key
// Supports cross-agent operations: if the secret belongs to ANY agent in the system,
// allow the request (for multi-agent collaboration)
function requireAgentAuth(req, res, next) {
  const agentId = req.params.agentId;
  const providedSecret = req.headers['x-agent-secret'];

  if (!agentId) {
    return next(); // No agent context, skip auth (e.g. POST /api/agents)
  }

  if (isLocalRequest(req) && process.env.DISABLE_LOCAL_DASHBOARD_BYPASS !== '1') {
    return next();
  }

  if (!providedSecret) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing X-Agent-Secret header'
    });
  }

  const storedSecret = Agent.getSecretKey(agentId);
  if (storedSecret && storedSecret === providedSecret) {
    return next(); // Direct match
  }

  // Cross-agent: check if secret belongs to any known agent
  const allAgents = Agent.findAll();
  const isKnownAgent = allAgents.some(a => a.secret_key === providedSecret);
  if (isKnownAgent) {
    return next();
  }

  // Agent not found → idempotent for DELETE, 404 for others
  if (!storedSecret && req.method === 'DELETE') {
    return res.status(200).json({ success: true, message: 'Agent not found or already deleted' });
  }

  if (!storedSecret) {
    return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
  }

  return res.status(403).json({
    error: 'Forbidden',
    message: 'Invalid agent secret'
  });
}

// Mount auth middleware on agent-scoped routes
app.use('/api/agents/:agentId', requireAgentAuth);
app.use('/api/agents', agentsRouter);
app.use('/api/agents/:agentId/todos', todosRouter);
app.use('/api/agents/:agentId/projects', projectsRouter);
app.use('/api/agents/:agentId/focus', focusRouter);
app.use('/api/agents/:agentId/contexts', contextsRouter);
app.use('/api/agents/:agentId/notifications', notificationsRouter);
app.use('/api/llm', llmRouter);

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.url} not found`
  });
});

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  });
});

app.listen(PORT, () => {
  logger.info(`Agent TODO Server is running on port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`API base URL: http://localhost:${PORT}/api`);

  try {
    getDb();
    logger.info('Database initialized successfully');
    const backfillResult = OpsBackfillService.backfillActiveRuns({ hours: 24 });
    const reconcileResult = OpsBackfillService.reconcileAutoHealingTasks();
    logger.info(`[OpsBackfill] 启动回填完成: scanned=${backfillResult.scannedTasks}, runsCreated=${backfillResult.runsCreated}, bucketsAssigned=${backfillResult.bucketsAssigned}, cancelledChildren=${reconcileResult.cancelledChildren}`);
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    process.exit(1);
  }

  // 初始化 Framework 单例，支持手动驱动任务
  let driveFramework = null;
  try {
    const { AgentTaskFramework } = require('../framework');
    driveFramework = AgentTaskFramework.fromConfig();
    driveFramework.initialize().then(() => {
      logger.info('[Framework] 已初始化，支持手动驱动');
    }).catch(err => {
      logger.error('[Framework] 初始化失败:', err.message);
    });
    // 挂载到 app 供路由使用
    app.set('driveFramework', driveFramework);

    const DriveOrchestrator = require('./services/DriveOrchestrator');
    const driveOrchestrator = new DriveOrchestrator({
      intervalMs: 60 * 1000,
      maxRetries: 3,
      retryBackoffMs: [0, 5000, 15000],
      driveCooldownMs: 60 * 1000,
      stallThreshold: 30 * 60 * 1000,
      useThirdPartyValidation: false,
      validationTimeoutMs: 30 * 60 * 1000,
    });
    driveOrchestrator.start(driveFramework);
    app.set('driveOrchestrator', driveOrchestrator);
  } catch (err) {
    logger.error('[Framework] 加载失败:', err.message);
  }

  // 通知去重冷却缓存（taskId+type -> 上次通知时间戳），防止相同类型通知反复刷屏
  const _notifCooldown = new Map();
  const _COOLDOWN_BY_TYPE = {
    recovered: 60 * 60 * 1000,
    blocked: 60 * 60 * 1000,
    zombie_blocked: 60 * 60 * 1000,
    stalled: 30 * 60 * 1000,
    assigned: 0,
    completion: 0,
    validation_timeout: 15 * 60 * 1000,
    validation_exhausted: 0,
  };
  function _shouldNotify(taskId, type, cooldownMs) {
    const effectiveCooldown = cooldownMs ?? _COOLDOWN_BY_TYPE[type] ?? (30 * 60 * 1000);
    if (effectiveCooldown === 0) return true;
    const key = `${taskId}:${type}`;
    const last = _notifCooldown.get(key) || 0;
    if (Date.now() - last < effectiveCooldown) return false;
    _notifCooldown.set(key, Date.now());
    if (_notifCooldown.size > 5000) {
      const oldest = [..._notifCooldown.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2500);
      _notifCooldown.clear();
      oldest.forEach(([k, v]) => _notifCooldown.set(k, v));
    }
    return true;
  }

  // 自动处理卡住的任务：每 3 分钟检查一次
  const STUCK_CHECK_INTERVAL_MS = 3 * 60 * 1000;
  const STUCK_MAX_IDLE_MINUTES = 15; // 无心跳超过 15 分钟视为卡住
  const PROGRESS_STALL_MINUTES = 15; // progress 超过 15 分钟未变化视为停滞
  const HERMES_TESTER_ID = process.env.VALIDATOR_AGENT_ID || 'hermes-tester';
  const HERMES_STALE_THRESHOLD_MS = 30 * 60 * 1000;

  setInterval(async () => {
    try {
      const db = getDb(); // 在 try 块开始时声明一次
      const agents = Agent.findAll();
      let totalStuck = 0;

      const hermesAgent = db.prepare('SELECT * FROM agents WHERE id = ?').get(HERMES_TESTER_ID);
      if (hermesAgent) {
        const recentHermesTasks = db.prepare(`
          SELECT MAX(updated_at) as last_update FROM todos WHERE agent_id = ? AND status IN ('validating', 'in_progress')
        `).get(HERMES_TESTER_ID);
        const lastUpdate = recentHermesTasks.last_update ? new Date(recentHermesTasks.last_update.replace(' ', 'T') + 'Z').getTime() : 0;
        if (lastUpdate > 0 && Date.now() - lastUpdate > HERMES_STALE_THRESHOLD_MS) {
          const staleMinutes = Math.round((Date.now() - lastUpdate) / 60000);
          logger.warn(`[StuckTaskMonitor] ⚠️ hermes-tester 健康警告：超过 ${staleMinutes} 分钟没有更新验证任务`);
          const validatingCount = db.prepare(`
            SELECT COUNT(*) as count FROM todos WHERE agent_id = ? AND status = 'validating'
          `).get(HERMES_TESTER_ID).count;
          if (validatingCount > 0) {
            logger.warn(`[StuckTaskMonitor] ⚠️ hermes-tester 有 ${validatingCount} 个验证任务卡住中，可能未正常运行`);
          }
        }
      }

      for (const agent of agents) {
        // 1. 检测无心跳卡住，自动恢复（看门狗模式：不消耗 attempt_count）
        // 动态阈值：基于 LLM 预估耗时和当前进度计算
        const inProgressTasks = Todo.findAllInProgress(agent.id);
        for (const task of inProgressTasks) {
          // Todo.findAllInProgress 已经解析了 JSON 字段，不需要再次解析
          // 冷却期检查：任务刚被更新（5分钟内），跳过检测
          // 防止任务刚启动就被误判为卡住
          const lastUpdate = task.updated_at ? new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
          if (Date.now() - lastUpdate < 5 * 60 * 1000) {
            continue; // 5分钟内更新过，跳过
          }

          // 检查智能体是否有聚焦此任务（说明智能体正在关注）
          const focusState = db.prepare(`
            SELECT * FROM focus_states WHERE agent_id = ? AND current_task_id = ?
          `).get(agent.id, task.id);
          if (focusState) {
            const focusUpdated = focusState.updated_at ? new Date(focusState.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
            if (Date.now() - focusUpdated < 10 * 60 * 1000) {
              continue; // 智能体最近10分钟内关注过此任务，跳过
            }
          }

          // 计算动态阈值
          const expectedDuration = task.expected_duration_minutes || null;
          const progress = task.heartbeat_progress || 0;
          let thresholdMinutes = STUCK_MAX_IDLE_MINUTES; // 默认 15 分钟
          let thresholdReason = '默认阈值';

          if (expectedDuration && expectedDuration > 0) {
            // 公式: max(15, min(120, 预估总耗时 × (1 - 进度%) × 0.5))
            const remainingRatio = 1 - (progress / 100);
            const calculated = Math.round(expectedDuration * remainingRatio * 0.5);
            thresholdMinutes = Math.max(15, Math.min(120, calculated));
            thresholdReason = `动态阈值(预估${expectedDuration}min, 进度${Math.round(progress)}%, 剩余${Math.round(remainingRatio * 100)}%)`;
          }

          // 检查是否超过阈值
          const lastHb = task.last_heartbeat ? new Date(task.last_heartbeat.replace(' ', 'T') + 'Z').getTime() : 0;
          const idleMinutes = lastHb ? Math.floor((Date.now() - lastHb) / 60000) : 999;
          if (idleMinutes < thresholdMinutes) continue; // 未超时，跳过

          const currentAttempts = task.attempt_count || 0;
          const maxAttempts = task.max_attempts || 3;

          const vc1a = task.validation_count || 0;

          if (currentAttempts < maxAttempts) {
            let newStatus = 'in_progress';
            let heartbeatStep = 'StuckTaskMonitor 自动恢复中，等待智能体重连...';
            
            if (vc1a >= 3 && task.status === 'in_progress') {
              Todo.update(agent.id, task.id, {
                status: 'blocked',
                heartbeatStep: `🔒 验证次数已耗尽(${vc1a})且无心跳，保持 blocked`,
                lastHeartbeat: new Date().toISOString()
              });
              JobRunService.setTaskFailureBucket(agent.id, task.id, 'no_heartbeat');
              logger.info(`[StuckTaskMonitor] 任务 ${task.id} 验证已耗尽(${vc1a})且无心跳，标记 blocked`);
              totalStuck++;
              continue;
            }

            if (task.status === 'pending_validation') {
              newStatus = 'pending_validation';
              heartbeatStep = 'StuckTaskMonitor 自动恢复（从 pending_validation），等待验证流程继续...';
            } else if (task.status === 'validating') {
              newStatus = 'pending_validation';
              heartbeatStep = 'StuckTaskMonitor 自动恢复（从 validating 超时），重新进入验证流程...';
            }
            
            Todo.update(agent.id, task.id, {
              status: newStatus,
              heartbeatStep: heartbeatStep,
              lastHeartbeat: new Date().toISOString()  // 更新心跳时间，防止短时间内重复触发
            });
            JobRunService.setTaskFailureBucket(agent.id, task.id, 'no_heartbeat');

            // 用 contexts 记录恢复事件（前端可见），但不污染 attempt_log
            Context.create(agent.id, {
              sessionId: 'auto-recover',
              role: 'system',
              content: `[StuckTaskMonitor] 任务「${task.title}」无心跳 ${idleMinutes} 分钟（超过${thresholdReason} ${thresholdMinutes} 分钟），已从 ${task.status} 自动恢复为 ${newStatus}（attempt_count 不变: ${currentAttempts}/${maxAttempts}）`,
              metadata: { type: 'auto_recover', task_id: task.id, original_status: task.status, new_status: newStatus, attempt_count: currentAttempts, threshold_minutes: thresholdMinutes, idle_minutes: idleMinutes }
            });
            Context.pruneBySession(agent.id, 'auto-recover', 50);

            Notification.create(agent.id, task.id, 'recovered',
              `任务「${task.title}」无心跳 ${idleMinutes} 分钟（超过${thresholdReason} ${thresholdMinutes} 分钟），StuckTaskMonitor 已自动恢复（attempt_count: ${currentAttempts}/${maxAttempts}）`
            );
            logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 自动恢复，${thresholdReason}=${thresholdMinutes}min, 实际idle=${idleMinutes}min, attempt_count 不变 ${currentAttempts}/${maxAttempts}`);
          } else {
            // 真正的工作尝试次数已耗尽，保持 blocked
            Todo.updateStatus(agent.id, task.id, 'blocked');
            if (_shouldNotify(task.id, 'blocked', 30 * 60 * 1000)) {
              Notification.create(agent.id, task.id, 'blocked',
                `任务「${task.title}」无心跳 ${idleMinutes} 分钟（超过${thresholdReason} ${thresholdMinutes} 分钟），且工作尝试次数已耗尽（${currentAttempts}/${maxAttempts}），需要人工介入`
              );
            }
            logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 尝试次数耗尽，保持 blocked`);
          }
          totalStuck++;
        }

        // 1b. 处理已 blocked 且长时间无心跳的任务（真正"卡住"的 blocked 任务）
        // 关键：只恢复 last_heartbeat 超过阈值的任务，避免和 Worker 的正常 blocked 判断冲突
        const blockedStuck = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'blocked'
            AND attempt_count < max_attempts
            AND (validation_count IS NULL OR validation_count < 3)
            AND (last_heartbeat IS NULL OR last_heartbeat < ?)
        `).all(agent.id, new Date(Date.now() - STUCK_MAX_IDLE_MINUTES * 60 * 1000).toISOString());
        const agentConcurrency = Agent.canAcceptNewTask(agent.id);
        for (const task of blockedStuck) {
          if (!agentConcurrency.canAccept) {
            logger.info(`[StuckTaskMonitor] Agent ${agent.id} 已达并发上限(${agentConcurrency.active}/${agentConcurrency.max})，跳过恢复「${task.title}」`);
            break;
          }
          // 冷却期检查：2 分钟内已更新过的任务跳过（防止和 Worker 竞态恢复）
          const lastUpdate = task.updated_at ? new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
          if (Date.now() - lastUpdate < 2 * 60 * 1000) {
            logger.info(`[StuckTaskMonitor] 任务 ${task.id} 2 分钟内已更新，跳过恢复`);
            continue;
          }

          // 同模板活跃实例去重：如果同一个模板已经有一个 pending/in_progress 的实例，不恢复此 blocked 任务
          if (task.parent_id) {
            const siblingActive = db.prepare(`
              SELECT id FROM todos
              WHERE agent_id = ? AND parent_id = ? AND id != ?
                AND status IN ('pending', 'in_progress')
                AND (archived = 0 OR archived IS NULL)
              LIMIT 1
            `).get(agent.id, task.parent_id, task.id);
            if (siblingActive) {
              logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 同模板已有活跃实例 ${siblingActive.id}，跳过恢复`);
              continue;
            }
          }

          const currentAttempts = task.attempt_count || 0;
          const maxAttempts = task.max_attempts || 3;
          const vc = task.validation_count || 0;
          if (vc >= 3) {
            logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 验证次数已耗尽(${vc})，保持 blocked`);
            continue;
          }

          Todo.update(agent.id, task.id, {
            status: 'in_progress',
            heartbeatStep: 'StuckTaskMonitor 自动恢复中（从 blocked 状态恢复），等待智能体重连...',
            lastHeartbeat: new Date().toISOString()
          });
          JobRunService.setTaskFailureBucket(agent.id, task.id, 'no_heartbeat');
          agentConcurrency.active++;

          // 用 contexts 记录恢复事件
          Context.create(agent.id, {
            sessionId: 'auto-recover',
            role: 'system',
            content: `[StuckTaskMonitor] 任务「${task.title}」从 blocked 自动恢复（无心跳超过 ${STUCK_MAX_IDLE_MINUTES} 分钟，attempt_count 不变: ${currentAttempts}/${maxAttempts}）`,
            metadata: { type: 'auto_recover', task_id: task.id, attempt_count: currentAttempts }
          });
          Context.pruneBySession(agent.id, 'auto-recover', 50);

          Notification.create(agent.id, task.id, 'recovered',
            `任务「${task.title}」从 blocked 自动恢复（无心跳超过 ${STUCK_MAX_IDLE_MINUTES} 分钟，attempt_count: ${currentAttempts}/${maxAttempts}）`
          );
          logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 从 blocked 自动恢复，attempt_count 不变 ${currentAttempts}/${maxAttempts}`);
          totalStuck++;
        }

        // 2. 检测进度停滞（有心跳但 progress 长时间未变化）
        const stalledTasks = Todo.findProgressStalledTasks(agent.id, PROGRESS_STALL_MINUTES);
        for (const task of stalledTasks) {
          if (_shouldNotify(task.id, 'stalled', 30 * 60 * 1000)) {
            const lastStep = task.heartbeat_step || '无';
            Notification.create(agent.id, task.id, 'stalled',
              `任务「${task.title}」进度停滞：已 ${PROGRESS_STALL_MINUTES} 分钟无进展，当前步骤：${lastStep}`
            );
            logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 进度停滞 ${PROGRESS_STALL_MINUTES} 分钟`);
          }
        }

        // 2b. 检测验证任务连续失败并发送纠正指导
        const FAILED_COMMAND_THRESHOLD = 3;
        const allActiveTasks = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status IN ('in_progress', 'validating')
            AND updated_at < ?
        `).all(agent.id, new Date(Date.now() - 10 * 60 * 1000).toISOString());

        const validationTasks = allActiveTasks.filter(t => isValidationTask(t));

        for (const task of validationTasks) {
          const lastStep = task.heartbeat_step || '';
          if (lastStep.includes('连续') && lastStep.includes('失败')) {
            const match = lastStep.match(/连续\s*(\d+)\s*次/);
            if (match && parseInt(match[1]) >= FAILED_COMMAND_THRESHOLD) {
              Context.create(agent.id, {
                sessionId: task.id,
                role: 'system',
                content: `[StuckTaskMonitor] 检测到${getTaskTypeLabel(task)}「${task.title}」连续命令失败。请检查：\n1. 确认命令是否正确（如 duckdb CLI 不存在，应使用 python3 -c "import duckdb..."）\n2. 如遇到无法解决的问题，请调用 POST /api/agents/${agent.id}/todos/${task.id}/request-help 请求帮助\n3. 避免重复执行相同的失败命令，尝试替代方案`,
                metadata: { type: 'corrective_guidance', task_id: task.id, failure_count: parseInt(match[1]) }
              });
              logger.info(`[StuckTaskMonitor] 已向${getTaskTypeLabel(task)} ${task.id} 发送纠正指导`);
            }
          }
        }

        // 2c. 验证任务超时检测：如果验证任务长时间未完成，自动发送提醒或重新分配
        const validationBehavior = getTaskBehavior({ title: '[验证]' });
        const VALIDATION_TIMEOUT_MINUTES = validationBehavior.timeoutMinutes;
        const validationTimeoutCutoff = new Date(Date.now() - VALIDATION_TIMEOUT_MINUTES * 60 * 1000).toISOString();

        // 检测 in_progress 状态的验证任务（可能是卡在执行阶段）
        const allInProgressTasks = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'in_progress'
            AND updated_at < ?
        `).all(agent.id, validationTimeoutCutoff);

        const stuckValidationTasks = allInProgressTasks.filter(t => isValidationTask(t));

        for (const task of stuckValidationTasks) {
          const idleMinutes = Math.floor((Date.now() - new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime()) / 60000);
          const lastStep = task.heartbeat_step || '';

          // 如果心跳步骤包含"LLM 响应中"且超过 15 分钟，可能是 LLM 调用卡住
          if (lastStep.includes('LLM 响应中') && idleMinutes >= 15) {
            Context.create(agent.id, {
              sessionId: task.id,
              role: 'system',
              content: `[StuckTaskMonitor] 检测到${getTaskTypeLabel(task)}「${task.title}」LLM 调用卡住（已 ${idleMinutes} 分钟无响应）。建议：\n1. 检查 LLM 服务是否正常\n2. 如果 LLM 无响应超过 5 分钟，可以手动重启 agent 进程\n3. 或调用 POST /api/agents/${agent.id}/todos/${task.id}/request-help 请求帮助`,
              metadata: { type: 'validation_timeout', task_id: task.id, idle_minutes: idleMinutes, last_step: lastStep }
            });
            logger.info(`[StuckTaskMonitor] ${getTaskTypeLabel(task)} ${task.id} LLM 调用卡住 ${idleMinutes} 分钟`);
            totalStuck++;
          }

          // 如果任务开始后超过 VALIDATION_TIMEOUT_MINUTES 仍未进入 validating 状态
          const createdAt = task.created_at ? new Date(task.created_at.replace(' ', 'T') + 'Z').getTime() : 0;
          const ageMinutes = Math.floor((Date.now() - createdAt) / 60000);
          if (ageMinutes >= VALIDATION_TIMEOUT_MINUTES && !lastStep.includes('LLM 响应中')) {
            // 非 LLM 卡住情况，可能是执行卡住
            Context.create(agent.id, {
              sessionId: task.id,
              role: 'system',
              content: `[StuckTaskMonitor] 检测到${getTaskTypeLabel(task)}「${task.title}」执行卡住（已运行 ${ageMinutes} 分钟，当前步骤: ${lastStep}）。建议：\n1. 检查任务是否在执行死循环\n2. 检查命令执行是否有阻塞\n3. 如无法解决，调用 POST /api/agents/${agent.id}/todos/${task.id}/request-help 请求帮助`,
              metadata: { type: 'validation_stuck', task_id: task.id, age_minutes: ageMinutes, last_step: lastStep }
            });
            logger.info(`[StuckTaskMonitor] ${getTaskTypeLabel(task)} ${task.id} 执行卡住 ${ageMinutes} 分钟`);
            totalStuck++;
          }
        }

        // 检测 validating 状态的验证任务（正在验证中但超时的）
        const pendingValidationTasks = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'pending_validation'
            AND updated_at < ?
        `).all(agent.id, validationTimeoutCutoff);

        for (const task of pendingValidationTasks) {
          const idleMinutes = Math.floor((Date.now() - new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime()) / 60000);
          const driveOrchestrator = app.get('driveOrchestrator');
          const shouldEscalate = _shouldNotify(task.id, 'validation_timeout', 15 * 60 * 1000);

          if (!shouldEscalate) {
            continue;
          }

          try {
            if (driveOrchestrator?.useThirdPartyValidation && driveOrchestrator.validationDispatcher) {
              const related = Context.findRecentByAgent(agent.id, 50)
                .filter(c => (c.metadata || {}).task_id === task.id);
              const logs = related.map(c => `[${c.session_id || 'session'}][${c.role}] ${c.content}`).join('\n---\n');
              await driveOrchestrator.validationDispatcher.dispatchValidationTask(agent.id, task, logs);
              const deadline = new Date(Date.now() + driveOrchestrator.validationTimeoutMs).toISOString();
              Todo.update(agent.id, task.id, {
                status: 'validating',
                validationDeadline: deadline,
                heartbeatStep: `📋 pending_validation 超时，已升级为第三方验证（超时: ${new Date(deadline).toLocaleString()}）`
              });
              driveOrchestrator.scheduleValidationTimeoutCheck(task.id, agent.id, driveOrchestrator.validationTimeoutMs);
              Context.create(agent.id, {
                sessionId: task.id,
                role: 'system',
                content: `[ValidationEscalation] 任务「${task.title}」pending_validation 已等待 ${idleMinutes} 分钟，已升级为第三方验证`,
                metadata: { type: 'pending_validation_escalated', task_id: task.id, idle_minutes: idleMinutes, mode: 'third_party' }
              });
              Notification.create(agent.id, task.id, 'validation_timeout',
                `任务「${task.title}」待验收超时，已升级给第三方验证`
              );
            } else if (driveOrchestrator?.validator) {
              Context.create(agent.id, {
                sessionId: task.id,
                role: 'system',
                content: `[ValidationEscalation] 任务「${task.title}」pending_validation 已等待 ${idleMinutes} 分钟，立即触发内嵌验收`,
                metadata: { type: 'pending_validation_escalated', task_id: task.id, idle_minutes: idleMinutes, mode: 'inline' }
              });
              Notification.create(agent.id, task.id, 'validation_timeout',
                `任务「${task.title}」待验收超时，已触发内嵌自动验收`
              );
              await driveOrchestrator.validator.validateTask(agent.id, task);
            }
          } catch (err) {
            logger.error(`[StuckTaskMonitor] pending_validation 升级失败: ${task.id} ${err.message}`);
          }

          totalStuck++;
        }

        // 检测 validating 状态的验证任务（正在验证中但超时的）
        const allValidatingTasks = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'validating'
            AND updated_at < ?
        `).all(agent.id, validationTimeoutCutoff);

        const staleValidatingTasks = allValidatingTasks.filter(t => isValidationTask(t));

        for (const task of staleValidatingTasks) {
          const idleMinutes = Math.floor((Date.now() - new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime()) / 60000);
          const deadline = task.validation_deadline ? new Date(task.validation_deadline).getTime() : 0;
          const isDeadlineExceeded = deadline > 0 && Date.now() > deadline;
          if (isDeadlineExceeded) {
            const vc = task.validation_count || 0;
            if (vc >= 3) {
              Todo.update(agent.id, task.id, {
                status: 'blocked',
                heartbeatStep: `🔒 验证次数已达上限(${vc}次)，需要人工介入`
              });
              Notification.create(agent.id, task.id, 'validation_exhausted',
                `任务「${task.title}」验证超时且已达次数上限(${vc}次)，已标记为阻塞`
              );
              logger.info(`[StuckTaskMonitor] ${getTaskTypeLabel(task)} ${task.id} 验证超时且达上限，标记阻塞`);
            } else {
              Todo.update(agent.id, task.id, {
                status: 'pending_validation',
                heartbeatStep: 'StuckTaskMonitor：验证超时，重新进入验证队列...'
              });
              Context.create(agent.id, {
                sessionId: task.id,
                role: 'system',
                content: `[StuckTaskMonitor] 检测到${getTaskTypeLabel(task)}「${task.title}」验证超时（已 ${idleMinutes} 分钟），已重新进入验证队列等待内嵌验证`,
                metadata: { type: 'validation_validating_timeout', task_id: task.id, idle_minutes: idleMinutes, action: 'requeue' }
              });
              Notification.create(agent.id, task.id, 'validation_timeout',
                `任务「${task.title}」第三方验证超时，已重新进入验证队列`
              );
              logger.info(`[StuckTaskMonitor] ${getTaskTypeLabel(task)} ${task.id} 验证超时 ${idleMinutes} 分钟，已重新入队`);
            }
          } else {
            Context.create(agent.id, {
              sessionId: task.id,
              role: 'system',
              content: `[StuckTaskMonitor] 检测到${getTaskTypeLabel(task)}「${task.title}」验证阶段等待中（已 ${idleMinutes} 分钟无更新）。hermes-tester 正在处理中...`,
              metadata: { type: 'validation_validating_pending', task_id: task.id, idle_minutes: idleMinutes }
            });
            logger.info(`[StuckTaskMonitor] ${getTaskTypeLabel(task)} ${task.id} 验证等待中 ${idleMinutes} 分钟`);
          }
          totalStuck++;
        }

        // 3. Fix 4: 自动重置长时间 blocked 任务的尝试次数（防止全部卡死）
        const BLOCKED_RESET_HOURS = 2; // blocked 超过 2 小时且尝试次数用尽，自动重置
        const blockedResetCutoff = new Date(Date.now() - BLOCKED_RESET_HOURS * 60 * 60 * 1000).toISOString();
        const blockedExhausted = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'blocked'
            AND attempt_count >= max_attempts
            AND updated_at < ?
        `).all(agent.id, blockedResetCutoff);
        for (const task of blockedExhausted) {
          const lastUpdate = task.updated_at ? new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
          if (Date.now() - lastUpdate < 10 * 60 * 1000) {
            continue;
          }

          const isValidationExhausted = (task.heartbeat_step || '').includes('验证次数已达上限')
            || (task.validation_count || 0) >= 3;
          if (isValidationExhausted) {
            continue;
          }

          // 安全解析 attempt_log
          let attemptLogArray;
          try {
            attemptLogArray = JSON.parse(task.attempt_log || '[]');
          } catch {
            attemptLogArray = [];
          }
          
          const newLog = [...attemptLogArray, {
            timestamp: new Date().toISOString(),
            success: false,
            reason: `系统自动重置：任务已 blocked 超过 ${BLOCKED_RESET_HOURS} 小时，重置尝试次数`,
            output: `StuckTaskMonitor 自动重置 attempt_count（${task.attempt_count} → 0）`
          }];

          Todo.update(agent.id, task.id, {
            status: 'pending',
            attemptCount: 0,
            attemptLog: newLog,
            heartbeatStep: '尝试次数已重置，等待重新调度...'
          });

          Notification.create(agent.id, task.id, 'recovered',
            `任务「${task.title}」已 blocked 超过 ${BLOCKED_RESET_HOURS} 小时，尝试次数自动重置为 0/3`
          );
          logger.info(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) blocked 超过 ${BLOCKED_RESET_HOURS}h，重置尝试次数`);
          totalStuck++;
        }
      }

      if (totalStuck > 0) {
        logger.info(`[StuckTaskMonitor] 本次处理 ${totalStuck} 个卡住任务`);
      }
    } catch (err) {
      logger.error('[StuckTaskMonitor] 检查卡住任务时出错:', err.message);
    }
  }, STUCK_CHECK_INTERVAL_MS);

  logger.info(`[StuckTaskMonitor] 已启动，每 ${STUCK_CHECK_INTERVAL_MS / 1000}s 检查一次，无心跳阈值 ${STUCK_MAX_IDLE_MINUTES} 分钟，进度停滞阈值 ${PROGRESS_STALL_MINUTES} 分钟`);

  // 自动归档旧任务：每天归档一次超过 30 天的 completed/cancelled 任务 + 清理超时 pending
  const ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const ARCHIVE_DAYS_OLD = 30;
  const STALE_PENDING_HOURS = 48;

  setInterval(() => {
    try {
      const agents = Agent.findAll();
      let totalArchived = 0;
      let totalCancelled = 0;
      let totalOrphans = 0;

      for (const agent of agents) {
        const archived = Todo.archiveOldCompleted(agent.id, ARCHIVE_DAYS_OLD);
        if (archived > 0) {
          logger.info(`[CleanupMonitor] Agent ${agent.id}: 归档了 ${archived} 个超过 ${ARCHIVE_DAYS_OLD} 天的旧任务`);
          totalArchived += archived;
        }

        const cancelled = Todo.cancelStalePending(agent.id, STALE_PENDING_HOURS);
        if (cancelled > 0) {
          logger.info(`[CleanupMonitor] Agent ${agent.id}: 取消了 ${cancelled} 个超过 ${STALE_PENDING_HOURS}h 的 pending 任务`);
          totalCancelled += cancelled;
        }

        const orphans = Todo.cancelOrphanChildren(agent.id);
        if (orphans > 0) {
          logger.info(`[CleanupMonitor] Agent ${agent.id}: 清理了 ${orphans} 个孤儿子任务（父任务已完成）`);
          totalOrphans += orphans;
        }
      }

      if (totalArchived > 0 || totalCancelled > 0 || totalOrphans > 0) {
        logger.info(`[CleanupMonitor] 本次: 归档 ${totalArchived}, 取消过期 ${totalCancelled}, 清理孤儿 ${totalOrphans}`);
      }
    } catch (err) {
      logger.error('[CleanupMonitor] 归档旧任务时出错:', err.message);
    }
  }, ARCHIVE_INTERVAL_MS);

  logger.info(`[CleanupMonitor] 已启动，每 ${ARCHIVE_INTERVAL_MS / 1000 / 60 / 60}h 清理一次，归档阈值 ${ARCHIVE_DAYS_OLD} 天，pending 过期 ${STALE_PENDING_HOURS}h`);

  // 定时调度任务引擎：每分钟检查到期的模板任务并生成实例
  const SCHEDULER_INTERVAL_MS = 60 * 1000;
  const CRON_FORCE_DRIVE_SOURCE = 'scheduled_task';
  const CRON_MAX_FORCED_DRIVES = parseInt(process.env.CRON_MAX_FORCED_DRIVES || '2', 10);
  const CRON_FORCE_DRIVE_GRACE_MINUTES = parseInt(process.env.CRON_FORCE_DRIVE_GRACE_MINUTES || '3', 10);
  const templatePreflightService = new TemplatePreflightService();
  const scheduleGovernanceService = new ScheduleGovernanceService();

  setInterval(async () => {
    try {
      const agents = Agent.findAll();
      let totalSpawned = 0;
      let totalForced = 0;
      const driveOrchestrator = app.get('driveOrchestrator');

      for (const agent of agents) {
        const dueTemplates = Todo.findDueTemplates(agent.id, new Date(), { reconcile: true });
        for (const template of dueTemplates) {
          try {
            const governance = scheduleGovernanceService.evaluateBeforeSpawn(agent.id, template);
            if (!governance.allowed) {
              JobRunService.appendSchedulerEvent(agent.id, 'task_spawn_skipped', {
                templateId: template.id,
                eventStatus: 'warn',
                details: {
                  source: 'daily_scheduler',
                  reason: governance.reason,
                  ...governance.details
                }
              });
              logger.warn(`[DailyScheduler] 模板 ${template.id} 跳过生成: ${governance.reason}`);
              continue;
            }

            const preflight = templatePreflightService.evaluateBeforeSpawn(agent.id, template);
            if (!preflight.allowed) {
              logger.warn(`[DailyScheduler] 模板 ${template.id} 跳过生成: ${preflight.reason} | ${((preflight.blockers || []).join('；')) || '无阻塞详情'}`);
              continue;
            }

            const spawned = Todo.spawnFromTemplate(agent.id, template.id, { replaceExisting: true });
            totalSpawned++;

            JobRunService.markSpawned(agent.id, spawned, {
              templateId: template.id,
              plannedAt: template.next_due_at || new Date().toISOString(),
              metadata: {
                source: 'daily_scheduler',
                template_title: template.title,
                schedule: template.schedule || null
              }
            });

            Context.create(agent.id, {
              sessionId: 'scheduler',
              role: 'system',
              content: `[DailyScheduler] 定时任务「${template.title}」已生成实例（ID: ${spawned.id}）`,
              metadata: { type: 'task_spawn', template_id: template.id, spawned_id: spawned.id }
            });

            Notification.create(agent.id, spawned.id, 'assigned',
              `定时模板「${template.title}」已生成执行实例，系统将立即尝试驱动`
            );

            if (driveOrchestrator) {
              const forced = await driveOrchestrator.triggerTaskDrive(agent.id, spawned.id, {
                source: CRON_FORCE_DRIVE_SOURCE,
                reason: 'template_spawned_immediate_drive',
                allowPendingChildren: true,
                maxForcedAttempts: CRON_MAX_FORCED_DRIVES
              });
              if (forced?.queued) {
                totalForced++;
              }
            }

            logger.info(`[DailyScheduler] Agent ${agent.id}: 从模板 ${template.id} 生成任务 ${spawned.id}「${spawned.title}」`);
          } catch (spawnErr) {
            JobRunService.appendSchedulerEvent(agent.id, 'task_spawn_failed', {
              templateId: template.id,
              eventStatus: 'error',
              details: {
                source: 'daily_scheduler',
                template_title: template.title,
                error: spawnErr.message
              }
            });
            logger.error(`[DailyScheduler] 模板 ${template.id} spawn 失败:`, spawnErr.message);
          }
        }
      }

      if (totalSpawned > 0 || totalForced > 0) {
        logger.info(`[DailyScheduler] 本次共生成 ${totalSpawned} 个定时任务实例，立即强制驱动 ${totalForced} 个`);
      }
    } catch (err) {
      logger.error('[DailyScheduler] 调度检查时出错:', err.message);
    }
  }, SCHEDULER_INTERVAL_MS);

  logger.info(`[DailyScheduler] 已启动，每 ${SCHEDULER_INTERVAL_MS / 1000}s 检查一次到期模板任务`);

  const CRON_START_GRACE_MINUTES = parseInt(process.env.CRON_START_GRACE_MINUTES || '10', 10);
  const CRON_NAG_COOLDOWN_MINUTES = parseInt(process.env.CRON_NAG_COOLDOWN_MINUTES || '60', 10);
  const CRON_MONITOR_OPS_AGENT_ID = process.env.CRON_MONITOR_OPS_AGENT_ID || 'hermes-ops';
  const CRON_MONITOR_INTERVAL_MS = 60 * 1000;
  const hasCronEscalation = (db, agentId, taskId) => {
    const row = db.prepare(`
      SELECT id FROM contexts
      WHERE agent_id = ?
        AND session_id = 'cron-monitor'
        AND metadata LIKE '%"type":"cron_force_drive_escalated"%'
        AND metadata LIKE ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(agentId, `%"task_id":"${taskId}"%`);
    return !!row;
  };
  const escalateCronTaskToOps = (db, task, executorId) => {
    if (!CRON_MONITOR_OPS_AGENT_ID || !Agent.exists(CRON_MONITOR_OPS_AGENT_ID)) {
      return { escalated: false, reason: 'ops_agent_unavailable' };
    }
    if (hasCronEscalation(db, task.agent_id, task.id)) {
      return { escalated: false, reason: 'already_escalated' };
    }

    const note = `[CronMonitor] 定时任务连续强制驱动仍未启动，升级给 ${CRON_MONITOR_OPS_AGENT_ID} 接管`;
    if (task.assigned_agent_id && task.assigned_agent_id !== CRON_MONITOR_OPS_AGENT_ID) {
      Todo.transfer(task.agent_id, task.id, CRON_MONITOR_OPS_AGENT_ID, note);
    } else if (!task.assigned_agent_id) {
      Todo.assign(task.agent_id, task.id, CRON_MONITOR_OPS_AGENT_ID, note);
    }

    FocusState.createOrUpdate(CRON_MONITOR_OPS_AGENT_ID, { currentTaskId: task.id, focusMode: 'auto' });

    const content = `[CronMonitor] 定时实例「${task.title}」(ID: ${task.id}) 连续强制驱动仍无心跳，已升级给 ${CRON_MONITOR_OPS_AGENT_ID} 接管。\n原执行方: ${executorId || task.agent_id}\n模板: ${task.template_title || '(unknown)'}\nschedule: ${task.template_schedule || '(none)'}`;
    Context.create(task.agent_id, {
      sessionId: 'cron-monitor',
      role: 'system',
      content,
      metadata: {
        type: 'cron_force_drive_escalated',
        task_id: task.id,
        template_id: task.parent_id,
        from_agent_id: executorId || task.agent_id,
        to_agent_id: CRON_MONITOR_OPS_AGENT_ID
      }
    });
    Context.create(CRON_MONITOR_OPS_AGENT_ID, {
      sessionId: 'cron-monitor',
      role: 'system',
      content,
      metadata: {
        type: 'cron_force_drive_escalated',
        task_id: task.id,
        template_id: task.parent_id,
        from_agent_id: executorId || task.agent_id,
        to_agent_id: CRON_MONITOR_OPS_AGENT_ID
      }
    });
    Notification.create(CRON_MONITOR_OPS_AGENT_ID, task.id, 'assigned',
      `[CronMonitor] 定时实例「${task.title}」连续强制驱动失败，已升级给你接管`
    );
    if (task.agent_id !== CRON_MONITOR_OPS_AGENT_ID) {
      Notification.create(task.agent_id, task.id, 'stalled',
        `[CronMonitor] 定时实例「${task.title}」已升级给 ${CRON_MONITOR_OPS_AGENT_ID} 接管`
      );
    }

    return { escalated: true, to: CRON_MONITOR_OPS_AGENT_ID };
  };

  setInterval(async () => {
    try {
      const db = getDb();
      const driveOrchestrator = app.get('driveOrchestrator');
      const overdueCutoff = new Date(Date.now() - CRON_START_GRACE_MINUTES * 60 * 1000).toISOString();
      const forceCutoff = new Date(Date.now() - CRON_FORCE_DRIVE_GRACE_MINUTES * 60 * 1000).toISOString();
      const notifyCutoff = new Date(Date.now() - CRON_NAG_COOLDOWN_MINUTES * 60 * 1000).toISOString();
      const overdueCutoffMs = Date.parse(overdueCutoff);

      let overdue;
      try {
        overdue = db.prepare(`
          SELECT t.*, p.title AS template_title, p.schedule AS template_schedule
          FROM todos t
          JOIN todos p ON p.id = t.parent_id AND p.agent_id = t.agent_id
          WHERE t.status = 'pending'
            AND (t.is_template = 0 OR t.is_template IS NULL)
            AND t.parent_id IS NOT NULL
            AND p.is_template = 1
            AND (t.archived = 0 OR t.archived IS NULL)
            AND t.created_at <= ?
            AND (t.last_heartbeat IS NULL OR t.last_heartbeat = '')
          ORDER BY t.created_at ASC
          LIMIT 50
        `).all(forceCutoff);
      } catch (sqlErr) {
        logger.error('[CronExecutionMonitor] SQL 查询出错:', sqlErr.message);
        return;
      }

      let totalNagged = 0;
      let totalForced = 0;
      let totalEscalated = 0;

      for (const task of overdue) {
        try {
          let forced = null;
          if (driveOrchestrator) {
            forced = await driveOrchestrator.triggerTaskDrive(task.agent_id, task.id, {
              source: CRON_FORCE_DRIVE_SOURCE,
              reason: 'cron_no_heartbeat_recovery',
              allowPendingChildren: true,
              maxForcedAttempts: CRON_MAX_FORCED_DRIVES
            });
            if (forced?.queued) {
              totalForced++;
            }
          }

          const taskCreatedAtMs = task.created_at
            ? new Date(task.created_at.replace(' ', 'T') + 'Z').getTime()
            : 0;
          if (!taskCreatedAtMs || taskCreatedAtMs > overdueCutoffMs) {
            continue;
          }

          const alreadyNotified = db.prepare(`
            SELECT id FROM task_notifications
            WHERE task_id = ?
              AND type = 'stalled'
              AND message LIKE '[CronMonitor]%'
              AND created_at >= ?
            LIMIT 1
          `).get(task.id, notifyCutoff);
          const executorId = task.assigned_agent_id || task.agent_id;
          if (forced?.reason === 'forced_attempt_limit_reached') {
            JobRunService.setTaskFailureBucket(task.agent_id, task.id, 'no_heartbeat');
            const escalation = escalateCronTaskToOps(db, task, executorId);
            if (escalation.escalated) {
              totalEscalated++;
            }
          }

          if (alreadyNotified) continue;

          const msg = `[CronMonitor] 定时实例超过 ${CRON_START_GRACE_MINUTES} 分钟仍未开始（无心跳）：「${task.title}」(ID: ${task.id})`;

          if (Agent.exists(executorId)) {
            Notification.create(executorId, task.id, 'stalled', msg);
          }
          if (task.agent_id && task.agent_id !== executorId && Agent.exists(task.agent_id)) {
            Notification.create(task.agent_id, task.id, 'stalled', msg);
          }
          if (CRON_MONITOR_OPS_AGENT_ID && CRON_MONITOR_OPS_AGENT_ID !== executorId && CRON_MONITOR_OPS_AGENT_ID !== task.agent_id && Agent.exists(CRON_MONITOR_OPS_AGENT_ID)) {
            Notification.create(CRON_MONITOR_OPS_AGENT_ID, task.id, 'stalled', msg);
          }

          Context.create(task.agent_id, {
            sessionId: 'cron-monitor',
            role: 'system',
            content: `${msg}\n模板: ${task.template_title || '(unknown)'}\nschedule: ${task.template_schedule || '(none)'}`,
            metadata: { type: 'cron_overdue', task_id: task.id, template_id: task.parent_id }
          });
          JobRunService.appendSchedulerEvent(task.agent_id, 'cron_overdue', {
            templateId: task.parent_id,
            taskId: task.id,
            eventStatus: 'warn',
            details: {
              source: 'cron_monitor',
              title: task.title,
              template_title: task.template_title || null,
              schedule: task.template_schedule || null
            }
          });
          JobRunService.setTaskFailureBucket(task.agent_id, task.id, 'no_heartbeat');
          Context.pruneBySession(task.agent_id, 'cron-monitor', 50);

          if (executorId === task.agent_id) {
            const current = FocusState.findByAgent(executorId);
            if (!current || current.current_task_id !== task.id) {
              FocusState.createOrUpdate(executorId, { currentTaskId: task.id, focusMode: 'auto' });
            }
          }

          totalNagged++;
        } catch (taskErr) {
          logger.error(`[CronExecutionMonitor] 任务 ${task.id} 处理失败: ${taskErr.message}`);
        }
      }

      if (totalNagged > 0 || totalForced > 0 || totalEscalated > 0) {
        logger.info(`[CronExecutionMonitor] 本次强制驱动 ${totalForced} 个未启动定时实例，升级 ${totalEscalated} 个，提醒 ${totalNagged} 个（强制阈值 ${CRON_FORCE_DRIVE_GRACE_MINUTES}min，提醒阈值 ${CRON_START_GRACE_MINUTES}min）`);
      }
    } catch (err) {
      logger.error('[CronExecutionMonitor] 扫描出错:', err.message, err.stack?.split('\n').slice(0, 3).join(' '));
    }
  }, CRON_MONITOR_INTERVAL_MS);

  logger.info(`[CronExecutionMonitor] 已启动，每 ${CRON_MONITOR_INTERVAL_MS / 1000}s 扫描 pending 定时实例；强制驱动阈值 ${CRON_FORCE_DRIVE_GRACE_MINUTES}min，提醒阈值 ${CRON_START_GRACE_MINUTES}min，提醒冷却 ${CRON_NAG_COOLDOWN_MINUTES}min`);

  // AssignmentDriver：每 60 秒扫描已指派但长时间未执行的任务，自动 focus + 通知
  const ASSIGN_DRIVER_INTERVAL_MS = 60 * 1000;
  const ASSIGN_STALE_MINUTES = 5;

  setInterval(async () => {
    try {
      const db = getDb();
      const agents = Agent.findAll();
      const driveOrchestrator = app.get('driveOrchestrator');
      let totalDriven = 0;

      for (const agent of agents) {
        const staleThreshold = new Date(Date.now() - ASSIGN_STALE_MINUTES * 60 * 1000).toISOString();

        const staleAssigned = db.prepare(`
          SELECT * FROM todos
          WHERE assigned_agent_id = ?
            AND status = 'pending'
            AND (assigned_at IS NOT NULL AND assigned_at <= ?)
            AND (is_template = 0 OR is_template IS NULL)
          ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
          LIMIT 5
        `).all(agent.id, staleThreshold);

        for (const rawTask of staleAssigned) {
          try {
            JobRunService.setTaskFailureBucket(agent.id, rawTask.id, 'not_started');
            const focus = FocusState.findByAgent(agent.id);
            if (focus && focus.current_task_id === rawTask.id) {
              continue;
            }

            FocusState.createOrUpdate(agent.id, { currentTaskId: rawTask.id, focusMode: 'auto' });
            if (driveOrchestrator) {
              await driveOrchestrator.triggerTaskDrive(agent.id, rawTask.id, {
                source: 'assignment_driver',
                reason: 'assigned_task_not_started',
                allowPendingChildren: true,
                setFocus: false
              });
            }

            Notification.create(agent.id, rawTask.id, 'assigned',
              `[AssignmentDriver] 任务「${rawTask.title}」被指派后超过 ${ASSIGN_STALE_MINUTES} 分钟未启动，已自动聚焦`
            );

            Context.create(agent.id, {
              sessionId: 'assignment-driver',
              role: 'system',
              content: `[AssignmentDriver] 任务「${rawTask.title}」被指派后超过 ${ASSIGN_STALE_MINUTES} 分钟未启动，已自动聚焦`,
              metadata: { type: 'assignment_driver_recover', task_id: rawTask.id, stale_minutes: ASSIGN_STALE_MINUTES }
            });
            Context.pruneBySession(agent.id, 'assignment-driver', 50);

            logger.info(`[AssignmentDriver] Agent ${agent.id}: 任务 ${rawTask.id}「${rawTask.title}」被指派后超时，已自动聚焦`);
            totalDriven++;
          } catch (taskErr) {
            logger.error(`[AssignmentDriver] 处理任务 ${rawTask.id} 失败:`, taskErr.message);
          }
        }
      }

      if (totalDriven > 0) {
        logger.info(`[AssignmentDriver] 本次共驱动 ${totalDriven} 个超时未执行的已指派任务`);
      }
    } catch (err) {
      logger.error('[AssignmentDriver] 巡检时出错:', err.message);
    }
  }, ASSIGN_DRIVER_INTERVAL_MS);

  logger.info(`[AssignmentDriver] 已启动，每 ${ASSIGN_DRIVER_INTERVAL_MS / 1000}s 扫描已指派但未执行的任务（超时阈值 ${ASSIGN_STALE_MINUTES} 分钟）`);

  // 工作快照轮询：每 2 分钟采集所有 Agent 工作状态（原 30s 产生过量 context 记录）
  const SNAPSHOT_INTERVAL_MS = 2 * 60 * 1000;
  const SNAPSHOT_MAX_RETAIN = 30;

  setInterval(() => {
    try {
      const agents = Agent.findAll();
      for (const agent of agents) {
        const focus = FocusState.getFocusContext(agent.id);
        const inProgressTasks = Todo.findAllByAgent(agent.id, { status: 'in_progress' });
        const maxConcurrent = agent.max_concurrent_tasks || 5;

        const snapshot = {
        agent_id: agent.id,
        agent_name: agent.name,
        timestamp: new Date().toISOString(),
        focus_task: focus?.current_task ? {
          id: focus.current_task.id,
          title: focus.current_task.title,
          status: focus.current_task.status,
          progress: focus.current_task.heartbeat_progress || 0,
          step: focus.current_task.heartbeat_step || '',
          blockers: Array.isArray(focus.current_task.heartbeat_blockers)
            ? focus.current_task.heartbeat_blockers
            : [],
          attempt_count: focus.current_task.attempt_count || 0
        } : null,
        in_progress_count: inProgressTasks.length,
        max_concurrent: maxConcurrent,
        in_progress_tasks: inProgressTasks.map(t => ({
          id: t.id,
          title: t.title,
          progress: t.heartbeat_progress || 0,
          step: t.heartbeat_step || '',
          blockers: Array.isArray(t.heartbeat_blockers)
            ? t.heartbeat_blockers
            : []
        }))
      };

        Context.create(agent.id, {
          sessionId: 'work-snapshot',
          role: 'system',
          content: JSON.stringify(snapshot),
          metadata: { type: 'work_snapshot', agent_id: agent.id }
        });

        // 清理旧快照，每个 Agent 保留最近 100 条
        Context.pruneBySession(agent.id, 'work-snapshot', SNAPSHOT_MAX_RETAIN);
      }
    } catch (err) {
      logger.error('[WorkSnapshotMonitor] 采集失败:', err.message);
    }
  }, SNAPSHOT_INTERVAL_MS);

  logger.info(`[WorkSnapshotMonitor] 已启动，每 ${SNAPSHOT_INTERVAL_MS / 1000}s 采集一次工作状态`);

  // ==================== LLM 辅助状态推断引擎 ====================
  // 当智能体超过 5 分钟没有主动报告心跳时，利用 LLM 分析最近活动记录，
  // 智能推断智能体当前真实状态，提前做出判断（而非被动等待 15 分钟 stuck 阈值）
  const ENABLE_LLM_INFERENCE = process.env.ENABLE_LLM_INFERENCE === '1' || process.env.ENABLE_LLM_INFERENCE === 'true';
  if (ENABLE_LLM_INFERENCE) {
    logger.info('[LLMInferencer] 已显式启用');
  } else {
    logger.info('[LLMInferencer] 默认关闭，避免高频低价值状态推断消耗 LLM 配额');
  }

  // ==================== 全局数据清理引擎 ====================
  // 每 6 小时自动清理膨胀的 contexts 和 notifications，控制数据库体积
  const GLOBAL_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const CONTEXT_MAX_AGE_DAYS = 7;
  const NOTIFICATION_MAX_AGE_DAYS = 3;
  const SNAPSHOT_PRUNE_KEEP = 20;
  const INFERENCE_PRUNE_KEEP = 20;
  const DRIVE_ORCHESTRATOR_PRUNE_KEEP = 100;
  const WORKER_PRUNE_KEEP = 50;

  setInterval(() => {
    try {
      const db = getDb();
      const agents = Agent.findAll();
      let totalCleaned = 0;

      for (const agent of agents) {
        const prunedCtx = Context.pruneOldContexts(agent.id, CONTEXT_MAX_AGE_DAYS);
        totalCleaned += prunedCtx;
        Context.pruneBySession(agent.id, 'work-snapshot', SNAPSHOT_PRUNE_KEEP);
        Context.pruneBySession(agent.id, 'llm-inference', INFERENCE_PRUNE_KEEP);
        Context.pruneBySession(agent.id, 'drive-orchestrator', DRIVE_ORCHESTRATOR_PRUNE_KEEP);
        Context.pruneBySession(agent.id, 'auto-recover', 20);
        Context.pruneBySession(agent.id, 'cron-monitor', 20);
        Context.pruneBySession(agent.id, 'assignment-driver', 20);
        const workerSession = 'worker_' + agent.id;
        Context.pruneBySession(agent.id, workerSession, WORKER_PRUNE_KEEP);
      }

      const notifCutoff = new Date(Date.now() - NOTIFICATION_MAX_AGE_DAYS * 24 * 3600 * 1000).toISOString();
      const delNotif = db.prepare(`DELETE FROM task_notifications WHERE created_at < ? AND read = 1`).run(notifCutoff);
      totalCleaned += delNotif.changes;

      if (totalCleaned > 0) {
        logger.info(`[GlobalCleanup] 已清理 ${totalCleaned} 条过期数据`);
      }
    } catch (err) {
      logger.error('[GlobalCleanup] 清理出错:', err.message);
    }
  }, GLOBAL_CLEANUP_INTERVAL_MS);

  logger.info(`[GlobalCleanup] 已启动，每 ${GLOBAL_CLEANUP_INTERVAL_MS / 3600000}h 清理一次（contexts 保留 ${CONTEXT_MAX_AGE_DAYS} 天，notifications 保留 ${NOTIFICATION_MAX_AGE_DAYS} 天已读）`);

  // ==================== 僵尸任务检测 ====================
  // 每 10 分钟检测 in_progress 但超过 2 小时无心跳的任务，自动标记 blocked
  const ZOMBIE_INTERVAL_MS = 10 * 60 * 1000;
  const ZOMBIE_THRESHOLD_MINUTES = 120;

  setInterval(() => {
    try {
      const db = getDb();
      const agents = Agent.findAll();
      let totalZombies = 0;

      for (const agent of agents) {
        const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_MINUTES * 60 * 1000).toISOString();
        const zombies = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'in_progress'
            AND is_template = 0 AND archived = 0
            AND (last_heartbeat IS NULL OR last_heartbeat < ?)
            AND updated_at < ?
        `).all(agent.id, cutoff, cutoff);

        for (const task of zombies) {
          const idleMin = task.last_heartbeat
            ? Math.round((Date.now() - new Date(task.last_heartbeat.replace(' ', 'T') + 'Z').getTime()) / 60000)
            : 9999;
          if (_shouldNotify(task.id, 'zombie_blocked', 60 * 60 * 1000)) {
            Todo.update(agent.id, task.id, {
              status: 'blocked',
              heartbeatStep: `🧟 僵尸任务（${idleMin} 分钟无心跳，超过 ${ZOMBIE_THRESHOLD_MINUTES} 分钟阈值）`
            });
            JobRunService.setTaskFailureBucket(agent.id, task.id, 'no_heartbeat');
            Notification.create(agent.id, task.id, 'blocked',
              `🧟 任务「${task.title}」超过 ${ZOMBIE_THRESHOLD_MINUTES} 分钟无心跳，自动标记为 blocked`
            );
            Context.create(agent.id, {
              sessionId: 'zombie-detector',
              role: 'system',
              content: `[ZombieDetector] 任务「${task.title}」超过 ${idleMin} 分钟无心跳，自动标记为 blocked`,
              metadata: { type: 'zombie_detect', task_id: task.id, idle_minutes: idleMin }
            });
            totalZombies++;
          }
        }
      }

      if (totalZombies > 0) {
        logger.info(`[ZombieDetector] 本次标记 ${totalZombies} 个僵尸任务为 blocked`);
      }
    } catch (err) {
      logger.error('[ZombieDetector] 检测出错:', err.message);
    }
  }, ZOMBIE_INTERVAL_MS);

  logger.info(`[ZombieDetector] 已启动，每 ${ZOMBIE_INTERVAL_MS / 60000}min 检测无心跳超 ${ZOMBIE_THRESHOLD_MINUTES}min 的僵尸任务`);

  setInterval(() => {
    try {
      const result = OpsBackfillService.backfillActiveRuns({ hours: 24 });
      const reconcile = OpsBackfillService.reconcileAutoHealingTasks();
      if (result.runsCreated > 0 || result.bucketsAssigned > 0 || reconcile.cancelledChildren > 0) {
        logger.info(`[OpsBackfill] 周期回填: scanned=${result.scannedTasks}, runsCreated=${result.runsCreated}, bucketsAssigned=${result.bucketsAssigned}, cancelledChildren=${reconcile.cancelledChildren}`);
      }
    } catch (err) {
      logger.error('[OpsBackfill] 周期回填失败:', err.message);
    }
  }, 10 * 60 * 1000);
});

module.exports = app;
