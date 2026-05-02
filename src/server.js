require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const agentsRouter = require('./routes/agents');
const todosRouter = require('./routes/todos');
const projectsRouter = require('./routes/projects');
const focusRouter = require('./routes/focus');
const contextsRouter = require('./routes/contexts');
const notificationsRouter = require('./routes/notifications');
const Agent = require('./models/Agent');
const Todo = require('./models/Todo');
const Notification = require('./models/Notification');
const Context = require('./models/Context');
const FocusState = require('./models/FocusState');
const { getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure logs directory exists
const logsDir = path.join(__dirname, '..', 'logs');
if (!require('fs').existsSync(logsDir)) {
  require('fs').mkdirSync(logsDir, { recursive: true });
}

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
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

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.url} not found`
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`Agent TODO Server is running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API base URL: http://localhost:${PORT}/api`);

  try {
    getDb();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  }

  // 初始化 Framework 单例，支持手动驱动任务
  let driveFramework = null;
  try {
    const { AgentTaskFramework } = require('../framework');
    driveFramework = AgentTaskFramework.fromConfig();
    driveFramework.initialize().then(() => {
      console.log('[Framework] 已初始化，支持手动驱动');
    }).catch(err => {
      console.error('[Framework] 初始化失败:', err.message);
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
    });
    driveOrchestrator.start(driveFramework);
    app.set('driveOrchestrator', driveOrchestrator);
  } catch (err) {
    console.error('[Framework] 加载失败:', err.message);
  }

  // 自动处理卡住的任务：每 3 分钟检查一次
  const STUCK_CHECK_INTERVAL_MS = 3 * 60 * 1000;
  const STUCK_MAX_IDLE_MINUTES = 15; // 无心跳超过 15 分钟视为卡住
  const PROGRESS_STALL_MINUTES = 15; // progress 超过 15 分钟未变化视为停滞

  setInterval(() => {
    try {
      const agents = Agent.findAll();
      let totalStuck = 0;

      for (const agent of agents) {
        // 1. 检测无心跳卡住，自动恢复（看门狗模式：不消耗 attempt_count）
        // 动态阈值：基于 LLM 预估耗时和当前进度计算
        const inProgressTasks = Todo.findAllInProgress(agent.id);
        for (const rawTask of inProgressTasks) {
          const task = {
            ...rawTask,
            tags: JSON.parse(rawTask.tags || '[]'),
            dependencies: JSON.parse(rawTask.dependencies || '[]'),
            attempt_log: JSON.parse(rawTask.attempt_log || '[]'),
            heartbeat_blockers: JSON.parse(rawTask.heartbeat_blockers || '[]')
          };

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

          if (currentAttempts < maxAttempts) {
            // Fix A: 自动恢复不消耗 attempt_count，只重置状态 + 更新 last_heartbeat
            Todo.update(agent.id, task.id, {
              status: 'in_progress',
              heartbeatStep: 'StuckTaskMonitor 自动恢复中，等待智能体重连...',
              lastHeartbeat: new Date().toISOString()  // 更新心跳时间，防止短时间内重复触发
            });

            // 用 contexts 记录恢复事件（前端可见），但不污染 attempt_log
            Context.create(agent.id, {
              sessionId: 'auto-recover',
              role: 'system',
              content: `[StuckTaskMonitor] 任务「${task.title}」无心跳 ${idleMinutes} 分钟（超过${thresholdReason} ${thresholdMinutes} 分钟），已自动恢复为 in_progress（attempt_count 不变: ${currentAttempts}/${maxAttempts}）`,
              metadata: { type: 'auto_recover', task_id: task.id, attempt_count: currentAttempts, threshold_minutes: thresholdMinutes, idle_minutes: idleMinutes }
            });
            Context.pruneBySession(agent.id, 'auto-recover', 50);

            Notification.create(agent.id, task.id, 'recovered',
              `任务「${task.title}」无心跳 ${idleMinutes} 分钟（超过${thresholdReason} ${thresholdMinutes} 分钟），StuckTaskMonitor 已自动恢复（attempt_count: ${currentAttempts}/${maxAttempts}）`
            );
            console.log(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 自动恢复，${thresholdReason}=${thresholdMinutes}min, 实际idle=${idleMinutes}min, attempt_count 不变 ${currentAttempts}/${maxAttempts}`);
          } else {
            // 真正的工作尝试次数已耗尽，保持 blocked
            Todo.updateStatus(agent.id, task.id, 'blocked');
            Notification.create(agent.id, task.id, 'blocked',
              `任务「${task.title}」无心跳 ${idleMinutes} 分钟（超过${thresholdReason} ${thresholdMinutes} 分钟），且工作尝试次数已耗尽（${currentAttempts}/${maxAttempts}），需要人工介入`
            );
            console.log(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 尝试次数耗尽，保持 blocked`);
          }
          totalStuck++;
        }

        // 1b. 处理已 blocked 且长时间无心跳的任务（真正"卡住"的 blocked 任务）
        // 关键：只恢复 last_heartbeat 超过阈值的任务，避免和 Worker 的正常 blocked 判断冲突
        const db = getDb();
        const blockedStuck = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'blocked'
            AND attempt_count < max_attempts
            AND (last_heartbeat IS NULL OR last_heartbeat < ?)
        `).all(agent.id, new Date(Date.now() - STUCK_MAX_IDLE_MINUTES * 60 * 1000).toISOString());
        for (const task of blockedStuck) {
          // 冷却期检查：2 分钟内已更新过的任务跳过（防止和 Worker 竞态恢复）
          const lastUpdate = task.updated_at ? new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
          if (Date.now() - lastUpdate < 2 * 60 * 1000) {
            console.log(`[StuckTaskMonitor] 任务 ${task.id} 2 分钟内已更新，跳过恢复`);
            continue;
          }

          const currentAttempts = task.attempt_count || 0;
          const maxAttempts = task.max_attempts || 3;

          // Fix A: 从 blocked 恢复也不消耗 attempt_count
          Todo.update(agent.id, task.id, {
            status: 'in_progress',
            heartbeatStep: 'StuckTaskMonitor 自动恢复中（从 blocked 状态恢复），等待智能体重连...',
            lastHeartbeat: new Date().toISOString()  // 更新心跳时间，防止短时间内重复触发
          });

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
          console.log(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 从 blocked 自动恢复，attempt_count 不变 ${currentAttempts}/${maxAttempts}`);
          totalStuck++;
        }

        // 2. 检测进度停滞（有心跳但 progress 长时间未变化）
        const stalledTasks = Todo.findProgressStalledTasks(agent.id, PROGRESS_STALL_MINUTES);
        for (const task of stalledTasks) {
          // 只通知，不自动改状态（可能是正常的长时任务）
          const lastStep = task.heartbeat_step || '无';
          Notification.create(agent.id, task.id, 'stalled',
            `任务「${task.title}」进度停滞：已 ${PROGRESS_STALL_MINUTES} 分钟无进展，当前步骤：${lastStep}`
          );
          console.log(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) 进度停滞 ${PROGRESS_STALL_MINUTES} 分钟`);
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
          // 冷却期检查
          const lastUpdate = task.updated_at ? new Date(task.updated_at.replace(' ', 'T') + 'Z').getTime() : 0;
          if (Date.now() - lastUpdate < 10 * 60 * 1000) {
            continue; // 10 分钟内更新过，跳过
          }

          const newLog = [...JSON.parse(task.attempt_log || '[]'), {
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
          console.log(`[StuckTaskMonitor] 任务 ${task.id} (${task.title}) blocked 超过 ${BLOCKED_RESET_HOURS}h，重置尝试次数`);
          totalStuck++;
        }
      }

      if (totalStuck > 0) {
        console.log(`[StuckTaskMonitor] 本次处理 ${totalStuck} 个卡住任务`);
      }
    } catch (err) {
      console.error('[StuckTaskMonitor] 检查卡住任务时出错:', err.message);
    }
  }, STUCK_CHECK_INTERVAL_MS);

  console.log(`[StuckTaskMonitor] 已启动，每 ${STUCK_CHECK_INTERVAL_MS / 1000}s 检查一次，无心跳阈值 ${STUCK_MAX_IDLE_MINUTES} 分钟，进度停滞阈值 ${PROGRESS_STALL_MINUTES} 分钟`);

  // 自动归档旧任务：每天归档一次超过 30 天的 completed/cancelled 任务
  const ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const ARCHIVE_DAYS_OLD = 30;

  setInterval(() => {
    try {
      const agents = Agent.findAll();
      let totalArchived = 0;

      for (const agent of agents) {
        const archived = Todo.archiveOldCompleted(agent.id, ARCHIVE_DAYS_OLD);
        if (archived > 0) {
          console.log(`[CleanupMonitor] Agent ${agent.id}: 归档了 ${archived} 个超过 ${ARCHIVE_DAYS_OLD} 天的旧任务`);
          totalArchived += archived;
        }
      }

      if (totalArchived > 0) {
        console.log(`[CleanupMonitor] 本次共归档 ${totalArchived} 个旧任务`);
      }
    } catch (err) {
      console.error('[CleanupMonitor] 归档旧任务时出错:', err.message);
    }
  }, ARCHIVE_INTERVAL_MS);

  console.log(`[CleanupMonitor] 已启动，每 ${ARCHIVE_INTERVAL_MS / 1000 / 60 / 60}h 归档一次，阈值 ${ARCHIVE_DAYS_OLD} 天`);

  // 定时调度任务引擎：每分钟检查到期的模板任务并生成实例
  const SCHEDULER_INTERVAL_MS = 60 * 1000;

  setInterval(() => {
    try {
      const agents = Agent.findAll();
      let totalSpawned = 0;

      for (const agent of agents) {
        // Fix legacy templates that have schedule but no next_due_at
        const templates = Todo.findTemplates(agent.id);
        for (const template of templates) {
          if (template.schedule && !template.next_due_at) {
            const nextDue = Todo.computeNextDueAt(template.schedule, new Date());
            if (nextDue) {
              Todo.update(agent.id, template.id, { nextDueAt: nextDue });
              console.log(`[DailyScheduler] 修复旧模板 ${template.id} 的 next_due_at: ${nextDue}`);
            }
          }
        }

        const dueTemplates = Todo.findDueTemplates(agent.id);
        for (const template of dueTemplates) {
          try {
            const spawned = Todo.spawnFromTemplate(agent.id, template.id, { replaceExisting: true });
            totalSpawned++;

            Context.create(agent.id, {
              sessionId: 'scheduler',
              role: 'system',
              content: `[DailyScheduler] 定时任务「${template.title}」已生成实例（ID: ${spawned.id}）`,
              metadata: { type: 'task_spawn', template_id: template.id, spawned_id: spawned.id }
            });

            Notification.create(agent.id, spawned.id, 'assigned',
              `定时模板「${template.title}」已生成执行实例，等待 cron job 认领执行`
            );

            console.log(`[DailyScheduler] Agent ${agent.id}: 从模板 ${template.id} 生成任务 ${spawned.id}「${spawned.title}」`);
          } catch (spawnErr) {
            console.error(`[DailyScheduler] 模板 ${template.id} spawn 失败:`, spawnErr.message);
          }
        }
      }

      if (totalSpawned > 0) {
        console.log(`[DailyScheduler] 本次共生成 ${totalSpawned} 个定时任务实例`);
      }
    } catch (err) {
      console.error('[DailyScheduler] 调度检查时出错:', err.message);
    }
  }, SCHEDULER_INTERVAL_MS);

  console.log(`[DailyScheduler] 已启动，每 ${SCHEDULER_INTERVAL_MS / 1000}s 检查一次到期模板任务`);

  const CRON_START_GRACE_MINUTES = parseInt(process.env.CRON_START_GRACE_MINUTES || '10', 10);
  const CRON_NAG_COOLDOWN_MINUTES = parseInt(process.env.CRON_NAG_COOLDOWN_MINUTES || '60', 10);
  const CRON_MONITOR_OPS_AGENT_ID = process.env.CRON_MONITOR_OPS_AGENT_ID || 'hermes-ops';
  const CRON_MONITOR_INTERVAL_MS = 60 * 1000;

  setInterval(() => {
    try {
      const db = getDb();
      const overdueCutoff = new Date(Date.now() - CRON_START_GRACE_MINUTES * 60 * 1000).toISOString();
      const notifyCutoff = new Date(Date.now() - CRON_NAG_COOLDOWN_MINUTES * 60 * 1000).toISOString();

      const overdue = db.prepare(`
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
      `).all(overdueCutoff);

      let totalNagged = 0;

      for (const task of overdue) {
        const alreadyNotified = db.prepare(`
          SELECT id FROM task_notifications
          WHERE task_id = ?
            AND type = 'stalled'
            AND message LIKE '[CronMonitor]%'
            AND created_at >= ?
          LIMIT 1
        `).get(task.id, notifyCutoff);
        if (alreadyNotified) continue;

        const executorId = task.assigned_agent_id || task.agent_id;
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
        Context.pruneBySession(task.agent_id, 'cron-monitor', 50);

        if (executorId === task.agent_id) {
          const current = FocusState.findByAgent(executorId);
          if (!current || current.current_task_id !== task.id) {
            FocusState.createOrUpdate(executorId, { currentTaskId: task.id, focusMode: 'cron-monitor' });
          }
        }

        totalNagged++;
      }

      if (totalNagged > 0) {
        console.log(`[CronExecutionMonitor] 本次标记/提醒 ${totalNagged} 个未按时启动的定时实例（阈值 ${CRON_START_GRACE_MINUTES}min）`);
      }
    } catch (err) {
      console.error('[CronExecutionMonitor] 扫描出错:', err.message);
    }
  }, CRON_MONITOR_INTERVAL_MS);

  console.log(`[CronExecutionMonitor] 已启动，每 ${CRON_MONITOR_INTERVAL_MS / 1000}s 扫描 pending 定时实例；启动阈值 ${CRON_START_GRACE_MINUTES}min，提醒冷却 ${CRON_NAG_COOLDOWN_MINUTES}min`);

  // AssignmentDriver：每 60 秒扫描已指派但长时间未执行的任务，自动 focus + 通知
  const ASSIGN_DRIVER_INTERVAL_MS = 60 * 1000;
  const ASSIGN_STALE_MINUTES = 5;

  setInterval(async () => {
    try {
      const db = getDb();
      const agents = Agent.findAll();
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
            const focus = FocusState.findByAgent(agent.id);
            if (focus && focus.current_task_id === rawTask.id) {
              continue;
            }

            FocusState.createOrUpdate(agent.id, { currentTaskId: rawTask.id, focusMode: 'auto' });

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

            console.log(`[AssignmentDriver] Agent ${agent.id}: 任务 ${rawTask.id}「${rawTask.title}」被指派后超时，已自动聚焦`);
            totalDriven++;
          } catch (taskErr) {
            console.error(`[AssignmentDriver] 处理任务 ${rawTask.id} 失败:`, taskErr.message);
          }
        }
      }

      if (totalDriven > 0) {
        console.log(`[AssignmentDriver] 本次共驱动 ${totalDriven} 个超时未执行的已指派任务`);
      }
    } catch (err) {
      console.error('[AssignmentDriver] 巡检时出错:', err.message);
    }
  }, ASSIGN_DRIVER_INTERVAL_MS);

  console.log(`[AssignmentDriver] 已启动，每 ${ASSIGN_DRIVER_INTERVAL_MS / 1000}s 扫描已指派但未执行的任务（超时阈值 ${ASSIGN_STALE_MINUTES} 分钟）`);

  // 工作快照轮询：每 30 秒采集所有 Agent 工作状态
  const SNAPSHOT_INTERVAL_MS = 30 * 1000;
  const SNAPSHOT_MAX_RETAIN = 100;

  setInterval(() => {
    try {
      const agents = Agent.findAll();
      for (const agent of agents) {
        const focus = FocusState.getFocusContext(agent.id);
        const inProgressTasks = Todo.findAllByAgent(agent.id, { status: 'in_progress' });

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
              : JSON.parse(focus.current_task.heartbeat_blockers || '[]'),
            attempt_count: focus.current_task.attempt_count || 0
          } : null,
          in_progress_count: inProgressTasks.length,
          in_progress_tasks: inProgressTasks.map(t => ({
            id: t.id,
            title: t.title,
            progress: t.heartbeat_progress || 0,
            step: t.heartbeat_step || '',
            blockers: Array.isArray(t.heartbeat_blockers)
              ? t.heartbeat_blockers
              : JSON.parse(t.heartbeat_blockers || '[]')
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
      console.error('[WorkSnapshotMonitor] 采集失败:', err.message);
    }
  }, SNAPSHOT_INTERVAL_MS);

  console.log(`[WorkSnapshotMonitor] 已启动，每 ${SNAPSHOT_INTERVAL_MS / 1000}s 采集一次工作状态`);

  // ==================== LLM 辅助状态推断引擎 ====================
  // 当智能体超过 5 分钟没有主动报告心跳时，利用 LLM 分析最近活动记录，
  // 智能推断智能体当前真实状态，提前做出判断（而非被动等待 15 分钟 stuck 阈值）
  const INFERENCE_INTERVAL_MS = 5 * 60 * 1000;   // 每 5 分钟运行一次
  const INFERENCE_MIN_IDLE_MS = 5 * 60 * 1000;   // 最少 idle 5 分钟才触发
  const INFERENCE_MAX_IDLE_MS = 15 * 60 * 1000;  // 超过 15 分钟交给 StuckTaskMonitor
  const INFERENCE_CONFIDENCE_THRESHOLD = 0.75;   // 置信度阈值

  setInterval(async () => {
    try {
      if (!driveFramework || !driveFramework.initialized) {
        return;
      }
      if (!driveFramework.modules.llmManager || !driveFramework.modules.llmManager.hasProvider()) {
        return;
      }

      const db = getDb();
      const agents = Agent.findAll();
      const now = Date.now();
      const minCutoff = new Date(now - INFERENCE_MIN_IDLE_MS).toISOString();
      const maxCutoff = new Date(now - INFERENCE_MAX_IDLE_MS).toISOString();

      for (const agent of agents) {
        // 查询 idle 5-15 分钟的 in_progress 任务
        const idleTasks = db.prepare(`
          SELECT * FROM todos
          WHERE agent_id = ? AND status = 'in_progress'
            AND last_heartbeat IS NOT NULL
            AND last_heartbeat < ?
            AND last_heartbeat >= ?
        `).all(agent.id, minCutoff, maxCutoff);

        for (const rawTask of idleTasks) {
          const task = {
            ...rawTask,
            tags: JSON.parse(rawTask.tags || '[]'),
            dependencies: JSON.parse(rawTask.dependencies || '[]'),
            attempt_log: JSON.parse(rawTask.attempt_log || '[]'),
            heartbeat_blockers: JSON.parse(rawTask.heartbeat_blockers || '[]')
          };

          // 检查该任务是否已在 10 分钟内被 LLM 推断过
          const recentInference = db.prepare(`
            SELECT created_at FROM contexts
            WHERE agent_id = ? AND session_id = 'llm-inference'
              AND metadata LIKE ?
            ORDER BY created_at DESC LIMIT 1
          `).get(agent.id, `%"task_id":"${task.id}"%`);
          if (recentInference) {
            const lastInferenceTime = new Date(recentInference.created_at).getTime();
            if (now - lastInferenceTime < 10 * 60 * 1000) {
              continue; // 10 分钟内已推断过，跳过
            }
          }

          const idleMinutes = Math.floor((now - new Date(task.last_heartbeat).getTime()) / 60000);

          // 收集最近活动记录
          const recentContexts = Context.findRecentByAgent(agent.id, 15);
          const activityLines = recentContexts.map(c => {
            const meta = typeof c.metadata === 'string' ? JSON.parse(c.metadata || '{}') : c.metadata;
            return `[${c.created_at}] ${meta.type || 'activity'}: ${c.content.substring(0, 120)}`;
          }).join('\n');

          // 收集执行记录
          const attemptLines = task.attempt_log.slice(-5).map((a, i) => {
            return `${i + 1}. [${a.success ? '成功' : '失败'}] ${a.reason || ''} — ${a.output || ''}`;
          }).join('\n') || '无执行记录';

          // 构建推断 Prompt
          const prompt = `你是一个 TODO Server 任务状态分析助手。请根据以下信息，推断智能体当前的真实工作状态。

## 当前任务
- 标题: ${task.title}
- 进度: ${task.heartbeat_progress || 0}%
- 最后心跳步骤: ${task.heartbeat_step || '无'}
- 阻塞项: ${task.heartbeat_blockers.length > 0 ? task.heartbeat_blockers.join('、') : '无'}
- 距离上次心跳: ${idleMinutes} 分钟
- 尝试次数: ${task.attempt_count || 0}/${task.max_attempts || 3}

## 最近活动记录
${activityLines}

## 执行记录
${attemptLines}

## 请判断
1. 智能体是否仍在有效工作？（true / false / uncertain）
2. 如果仍在工作，当前可能在做什么？（一句话描述）
3. 如果未工作，最可能的原因是什么？（等待输入 / 遇到错误 / 已完成 / 失联 / 其他）
4. 建议的任务状态：（in_progress / blocked / completed）
5. 置信度（0-1 之间的小数）

请只返回纯 JSON，不要有任何其他文字：
{"is_working": true, "current_action": "...", "reason": "...", "suggested_status": "in_progress", "confidence": 0.85}`;

          try {
            const llmResult = await driveFramework.modules.llmManager.chat({
              messages: [{ role: 'user', content: prompt }],
              system: '你是一个任务状态分析助手，请基于活动记录推断智能体状态，只返回 JSON。'
            });

            const reply = llmResult.content || '';
            // 尝试从回复中提取 JSON
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            let inference = null;
            if (jsonMatch) {
              try {
                inference = JSON.parse(jsonMatch[0]);
              } catch (parseErr) {
                console.log(`[LLMInferencer] JSON 解析失败: ${parseErr.message}`);
              }
            }

            if (!inference || typeof inference.confidence !== 'number') {
              console.log(`[LLMInferencer] 任务 ${task.id} LLM 返回格式异常，跳过处理`);
              continue;
            }

            const confidence = inference.confidence;
            const suggestedStatus = inference.suggested_status;
            const isWorking = inference.is_working;

            console.log(`[LLMInferencer] 任务 ${task.id} (${task.title.substring(0, 30)}...) | ` +
              `is_working=${isWorking} | suggested=${suggestedStatus} | confidence=${confidence}`);

            // 记录推断结果到 contexts
            Context.create(agent.id, {
              sessionId: 'llm-inference',
              role: 'system',
              content: `[LLM推断] 任务「${task.title}」idle ${idleMinutes}min | ` +
                `is_working=${isWorking} | suggested=${suggestedStatus} | confidence=${confidence} | reason=${inference.reason || ''}`,
              metadata: {
                type: 'llm_inference',
                task_id: task.id,
                inference: inference,
                idle_minutes: idleMinutes
              }
            });
            Context.pruneBySession(agent.id, 'llm-inference', 50);

            // 根据置信度和推断结果采取行动
            if (confidence >= INFERENCE_CONFIDENCE_THRESHOLD) {
              if (suggestedStatus === 'completed' && isWorking === false) {
                // LLM 判断任务已完成
                Todo.update(agent.id, task.id, {
                  status: 'completed',
                  heartbeatStep: 'LLM 推断已完成：' + (inference.reason || '')
                });
                Notification.create(agent.id, task.id, 'completed',
                  `任务「${task.title}」被 LLM 推断为已完成（置信度 ${Math.round(confidence * 100)}%），原因：${inference.reason || ''}`
                );
                console.log(`[LLMInferencer] 任务 ${task.id} 自动标记为 completed`);

              } else if (suggestedStatus === 'blocked' && isWorking === false) {
                // LLM 判断任务已卡住，提前标记 blocked
                const newLog = [...task.attempt_log, {
                  timestamp: new Date().toISOString(),
                  success: false,
                  reason: `LLM 推断提前标记 blocked（idle ${idleMinutes} 分钟）`,
                  output: inference.reason || 'LLM 推断智能体已停止工作'
                }];
                Todo.update(agent.id, task.id, {
                  status: 'blocked',
                  attemptCount: task.attempt_count + 1,
                  attemptLog: newLog,
                  heartbeatStep: 'LLM 推断已卡住：' + (inference.reason || '')
                });
                Notification.create(agent.id, task.id, 'blocked',
                  `任务「${task.title}」被 LLM 推断为已卡住（置信度 ${Math.round(confidence * 100)}%），原因：${inference.reason || ''}`
                );
                console.log(`[LLMInferencer] 任务 ${task.id} 提前标记为 blocked`);

              } else if (isWorking === true && inference.current_action) {
                // LLM 判断仍在工作，更新心跳步骤
                Todo.updateHeartbeat(agent.id, task.id, {
                  step: `LLM 推断: ${inference.current_action}`
                });
                console.log(`[LLMInferencer] 任务 ${task.id} 更新心跳步骤: ${inference.current_action}`);
              }
            }
          } catch (llmErr) {
            console.error(`[LLMInferencer] LLM 调用失败: ${llmErr.message}`);
          }
        }
      }
    } catch (err) {
      console.error('[LLMInferencer] 状态推断出错:', err.message);
    }
  }, INFERENCE_INTERVAL_MS);

  console.log(`[LLMInferencer] 已启动，每 ${INFERENCE_INTERVAL_MS / 60000}min 运行一次，` +
    `触发阈值 ${INFERENCE_MIN_IDLE_MS / 60000}-${INFERENCE_MAX_IDLE_MS / 60000}min，` +
    `置信度阈值 ${INFERENCE_CONFIDENCE_THRESHOLD}`);
});

module.exports = app;
