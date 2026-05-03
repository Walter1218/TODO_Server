/**
 * Agent Worker - 智能体持续工作进程
 * 
 * 解决框架"被动响应"的问题：
 * - 定期轮询 focus 任务
 * - 自动驱动智能体继续执行 in_progress 任务
 * - 独立维护心跳保活
 */

const { AgentTaskFramework } = require('./framework');
const { getDb } = require('./src/db');
const CommandExecutor = require('./src/services/CommandExecutor');

const WORK_INTERVAL_MS = 30 * 1000;      // 工作轮询间隔：30秒
const HEARTBEAT_INTERVAL_MS = 60 * 1000;  // 心跳间隔：1分钟
const WORK_PROMPT_INTERVAL_MS = 5 * 60 * 1000; // 主动工作触发间隔：5分钟
const ACTIVITY_LOG_LIMIT = 200; // 最多保留 200 条活动记录

class AgentWorker {
  constructor(agentId = null, configPath = null) {
    this.framework = null;
    this.heartbeatTimer = null;
    this.workTimer = null;
    this.lastWorkTime = 0;
    this.currentTaskId = null;
    this.isRunning = false;
    this.workLoopCount = 0;        // 工作循环计数器，用于周期性 focus 同步
    this.lastFocusSyncTime = 0;    // 上次强制同步 focus 的时间
    this.workLoopBusy = false;     // 防止 _workLoop 并发执行
    this.consecutiveCmdFailures = 0; // 当前任务连续命令失败次数
    this.agentId = agentId;        // 指定的 agent ID
    this.configPath = configPath;  // 指定的配置文件路径
  }

  async start() {
    console.log('🚀 Agent Worker 启动中...');

    // 1. 初始化框架（支持指定 agentId 和配置文件路径）
    const configOverride = this.agentId ? { base: { agentId: this.agentId } } : {};
    this.framework = AgentTaskFramework.fromConfig(this.configPath, configOverride);
    await this.framework.initialize();
    
    // 显示使用的 agent ID
    if (this.agentId) {
      console.log(`🎯 使用指定的 Agent ID: ${this.agentId}`);
    }

    const status = this.framework.getStatus();
    console.log('📊 框架状态：');
    console.log('   - 已初始化:', status.initialized);
    console.log('   - LLM:', status.llm?.provider || '未配置');
    console.log('   - 活跃模块:', status.activeModules.join(', '));

    // 2. 立即执行一次 focus 检查和启动
    await this._checkAndStartFocusTask();

    // 3. 启动独立心跳（不依赖 processMessage）
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), HEARTBEAT_INTERVAL_MS);

    // 4. 启动工作循环
    this.workTimer = setInterval(() => this._workLoopSafe(), WORK_INTERVAL_MS);

    this.isRunning = true;
    console.log('✅ Agent Worker 已启动');
    console.log(`   - 心跳间隔: ${HEARTBEAT_INTERVAL_MS / 1000}s`);
    console.log(`   - 工作轮询: ${WORK_INTERVAL_MS / 1000}s`);
    console.log(`   - 主动工作触发: ${WORK_PROMPT_INTERVAL_MS / 60000}min`);
    console.log('   按 Ctrl+C 停止\n');

    // 保持进程运行
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * 记录 focus 切换日志
   */
  _logFocusSwitch(reason, fromTask, toTask) {
    const timestamp = new Date().toISOString();
    const logPrefix = `[FocusSwitch][${reason}]`;

    if (fromTask) {
      console.log(`${logPrefix} 切换 | 来源: ${fromTask.id} (${fromTask.status}) "${fromTask.title}" | 目标: ${toTask.id} "${toTask.title}"`);
    } else {
      console.log(`${logPrefix} 切换 | 来源: null | 目标: ${toTask.id} "${toTask.title}"`);
    }

    try {
      const db = getDb();
      const sessionId = `worker_${this.framework.config.base.agentId}`;
      const id = require('uuid').v4();
      db.prepare(`
        INSERT INTO contexts (id, agent_id, session_id, role, content, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        this.framework.config.base.agentId,
        sessionId,
        'system',
        `[FocusSwitch] focus 切换 | 原因: ${reason} | ${fromTask ? `从 "${fromTask.title}" (${fromTask.status})` : '无来源任务'} → "${toTask.title}" (${toTask.status})`,
        JSON.stringify({
          type: 'focus_switch',
          reason,
          fromTaskId: fromTask?.id,
          fromTaskStatus: fromTask?.status,
          fromTaskTitle: fromTask?.title,
          toTaskId: toTask.id,
          toTaskStatus: toTask.status,
          toTaskTitle: toTask.title,
          timestamp
        })
      );
    } catch (err) {
      console.warn('[FocusSwitch] 记录上下文失败:', err.message);
    }
  }

  /**
   * 检查 focus 任务并自动启动/恢复
   */
  async _checkAndStartFocusTask() {
    try {
      const focusTask = await this.framework.getCurrentFocusTask();
      const previousTaskId = this.currentTaskId;
      console.log(`[_checkFocus] focusTask=${focusTask ? 'OK' : 'NULL'} | status=${focusTask?.status} | id=${focusTask?.id}`);
      if (!focusTask) {
        console.log('📭 当前无聚焦任务，等待中...');
        this.currentTaskId = null;
        return;
      }

      // 如果 focus 任务是 pending，自动启动它
      if (focusTask.status === 'pending') {
        const prevTask = previousTaskId ? await this.framework.modules.taskManager.todo.getTodo(previousTaskId).catch(() => null) : null;
        console.log(`▶️ 自动启动任务: ${focusTask.title}`);
        this._logFocusSwitch('task_start', prevTask?.data || prevTask, focusTask);
        await this.framework._autoStartTask(focusTask);
        this.currentTaskId = focusTask.id;
        this.lastWorkTime = Date.now();
        this.consecutiveCmdFailures = 0;
        await this._recordActivity('task_start', `自动启动任务: ${focusTask.title}`, focusTask.id);
        return;
      }

      // 如果 focus 任务是 blocked 但还有重试次数，自动恢复
      if (focusTask.status === 'blocked') {
        const attempts = focusTask.attempt_count || 0;
        const maxAttempts = focusTask.max_attempts || 3;
        if (attempts < maxAttempts) {
          const prevTask = previousTaskId ? await this.framework.modules.taskManager.todo.getTodo(previousTaskId).catch(() => null) : null;
          console.log(`🔄 自动恢复 blocked 任务: ${focusTask.title} (${attempts}/${maxAttempts} → ${attempts+1}/${maxAttempts})`);
          this._logFocusSwitch('task_recover', prevTask?.data || prevTask, focusTask);
          await this._recoverBlockedTask(focusTask);
          this.currentTaskId = focusTask.id;
          this.lastWorkTime = Date.now();
          await this._recordActivity('task_recover', `从 blocked 恢复任务: ${focusTask.title}, 第 ${attempts+1} 次尝试`, focusTask.id);
          return;
        } else {
          console.log(`⛔ 任务 ${focusTask.title} 已达到最大重试次数 (${maxAttempts})，跳过`);
          // 尝试寻找其他可执行的任务
          await this._trySwitchFocus();
          return;
        }
      }

      // 如果 focus 任务是 in_progress 或 validating，更新当前跟踪
      if (['in_progress', 'validating'].includes(focusTask.status)) {
        if (this.currentTaskId !== focusTask.id) {
          const prevTask = previousTaskId ? await this.framework.modules.taskManager.todo.getTodo(previousTaskId).catch(() => null) : null;
          console.log(`📋 当前聚焦任务: ${focusTask.title} (ID: ${focusTask.id})`);
          this._logFocusSwitch('focus_update', prevTask?.data || prevTask, focusTask);
          this.currentTaskId = focusTask.id;
        }
        this.lastWorkTime = Date.now();  // 总是更新时间，避免长时间不工作
      }
      
      // 如果 focus 任务已完成，尝试切换到下一个任务
      if (focusTask.status === 'completed') {
        console.log(`✅ 当前 focus 任务已完成: ${focusTask.title}，尝试切换到下一个任务`);
        this._logFocusSwitch('task_completed', focusTask, { id: 'next_task', title: '待定', status: 'pending' });
        await this._trySwitchFocus();
        return;
      }

      // 如果 focus 任务已取消，尝试切换到下一个任务
      if (focusTask.status === 'cancelled') {
        console.log(`❌ 当前 focus 任务已取消: ${focusTask.title}，尝试切换到下一个任务`);
        this._logFocusSwitch('task_cancelled', focusTask, { id: 'next_task', title: '待定', status: 'pending' });
        this.currentTaskId = null;
        await this._trySwitchFocus();
        return;
      }
    } catch (err) {
      console.error('❌ Focus 检查失败:', err.message);
      console.error(err.stack);
    }
  }

  /**
   * 恢复 blocked 任务为 in_progress
   */
  async _recoverBlockedTask(task) {
    try {
      // 冷却期检查：2 分钟内已更新过的任务跳过（防止竞态恢复）
      const lastUpdate = new Date(task.updated_at || 0).getTime();
      if (Date.now() - lastUpdate < 2 * 60 * 1000) {
        console.log(`[Worker] 任务 ${task.id} 2 分钟内已更新，跳过恢复`);
        return;
      }

      const currentAttempts = task.attempt_count || 0;
      const oldBlockers = Array.isArray(task.heartbeat_blockers)
        ? task.heartbeat_blockers
        : JSON.parse(task.heartbeat_blockers || '[]');
      const newLog = [...(task.attempt_log || []), {
        timestamp: new Date().toISOString(),
        success: false,
        reason: `Worker 自动恢复: 任务 blocked 但还有重试次数，触发第 ${currentAttempts + 1} 次尝试`,
        output: `AgentWorker 自动恢复${oldBlockers.length > 0 ? ' · 原阻塞：' + oldBlockers.join('、') : ''}`
      }];

      await this.framework.modules.taskManager.todo.updateTodo(task.id, {
        status: 'in_progress',
        attemptCount: currentAttempts + 1,
        attemptLog: newLog,
        heartbeatStep: 'Worker 自动恢复中，继续执行任务...'
      });

      // 启动心跳
      this.framework._startHeartbeat(task.id);
    } catch (err) {
      console.error('❌ 恢复 blocked 任务失败:', err.message);
    }
  }

  /**
   * 尝试切换到其他可执行的任务
   */
  async _trySwitchFocus() {
    try {
      const readyTasks = await this.framework.modules.taskManager.getReadyTasks();
      if (readyTasks && readyTasks.length > 0) {
        const prevTask = this.currentTaskId ? await this.framework.modules.taskManager.todo.getTodo(this.currentTaskId).catch(() => null) : null;
        const nextTask = readyTasks[0];
        console.log(`🔄 切换到下一个可执行任务: ${nextTask.title}`);
        this._logFocusSwitch('auto_switch', prevTask?.data || prevTask, nextTask);
        // 通过 focus API 设置新 focus
        await this.framework.modules.taskManager.todo.updateTodo(nextTask.id, {
          status: 'in_progress'
        });
        this.currentTaskId = nextTask.id;
        this.lastWorkTime = Date.now();
        this.consecutiveCmdFailures = 0;
        this.framework._startHeartbeat(nextTask.id);
        await this._recordActivity('focus_switch', `切换到新任务: ${nextTask.title}`, nextTask.id);

        // 同步服务器 focus_states（修复同步问题 #3）
        try {
          await this.framework.modules.taskManager.todo.setFocus(nextTask.id, {
            focusMode: 'auto'
          });
          console.log(`[Worker] 已同步服务器 focus 到: ${nextTask.id}`);
        } catch (syncErr) {
          console.warn(`[Worker] 同步服务器 focus 失败: ${syncErr.message}`);
        }
      }
    } catch (err) {
      console.error('❌ 切换 focus 失败:', err.message);
    }
  }

  /**
   * 独立心跳发送（不依赖 processMessage）
   */
  async _sendHeartbeat() {
    if (!this.currentTaskId) return;

    try {
      // 获取最新任务状态
      const taskResult = await this.framework.modules.taskManager.todo.getTodo(this.currentTaskId);
      const task = taskResult.data || taskResult;
      if (!task || !['in_progress', 'validating'].includes(task.status)) {
        this.currentTaskId = null;
        return;
      }

      // 只刷新 last_heartbeat，不覆盖 Hermes 管理的 progress/step/blockers
      await this.framework._sendHeartbeat(this.currentTaskId, {});

      console.log(`💓 保活心跳 | 任务: ${task.title.substring(0, 30)}... | 进度: ${task.heartbeat_progress || 0}% (Hermes 管理)`);
    } catch (err) {
      console.error('❌ 心跳发送失败:', err.message);
    }
  }

  /**
   * 安全包装：防止 _workLoop 并发执行
   */
  async _workLoopSafe() {
    if (this.workLoopBusy) {
      console.log('[_workLoop] 上一次循环仍在执行，跳过');
      return;
    }
    this.workLoopBusy = true;
    try {
      await this._workLoop();
    } finally {
      this.workLoopBusy = false;
    }
  }

  /**
   * 工作循环：定期检查并驱动智能体工作
   */
  async _workLoop() {
    try {
      this.workLoopCount++;

      // 0. 每 10 次循环（约 5 分钟）强制同步一次服务器 focus（修复同步问题 #1）
      if (this.workLoopCount % 10 === 0) {
        try {
          const serverFocus = await this.framework.getCurrentFocusTask();
          if (serverFocus && serverFocus.id !== this.currentTaskId) {
            console.log(`[Worker] 服务器 focus 已切换: ${this.currentTaskId} → ${serverFocus.id}`);
            this.currentTaskId = serverFocus.id;
            this.lastWorkTime = Date.now();
            await this._recordActivity('focus_sync', `服务器 focus 同步: ${serverFocus.id}`, serverFocus.id);
          }
        } catch (syncErr) {
          console.warn(`[Worker] 同步服务器 focus 失败: ${syncErr.message}`);
        }
      }

      // 1. 如果没有 currentTaskId，尝试获取 focus 任务
      if (!this.currentTaskId) {
        await this._checkAndStartFocusTask();
        if (!this.currentTaskId) {
          console.log('[_workLoop] 无 focus 任务，跳过');
          return;
        }
      }

      // 2. 获取当前任务详情
      let task;
      try {
        const taskResult = await this.framework.modules.taskManager.todo.getTodo(this.currentTaskId);
        task = taskResult.data || taskResult;
      } catch (err) {
        console.log('[_workLoop] 获取任务失败，尝试重新获取 focus:', err.message);
        this.currentTaskId = null;
        return;
      }

      if (!task) {
        console.log('[_workLoop] 任务不存在，尝试重新获取 focus');
        this.currentTaskId = null;
        return;
      }

      // 如果任务 blocked 但可恢复，先恢复它
      if (task.status === 'blocked') {
        const attempts = task.attempt_count || 0;
        const maxAttempts = task.max_attempts || 3;
        if (attempts < maxAttempts) {
          console.log(`🔄 工作循环中发现 blocked 可恢复任务，自动恢复: ${task.title}`);
          await this._recoverBlockedTask(task);
        } else {
          console.log(`[_workLoop] 任务 ${task.title} 已用尽重试次数，尝试切换 focus`);
          this.currentTaskId = null;
          await this._trySwitchFocus();
        }
        return;
      }

      if (!['in_progress', 'validating'].includes(task.status)) {
        console.log(`[_workLoop] 任务状态 ${task.status}，尝试重新获取 focus`);
        this.currentTaskId = null;
        return;
      }

      const now = Date.now();
      const timeSinceLastWork = now - this.lastWorkTime;

      // 3. 判断是否需要触发智能体工作
      const isWaitingState = (task.heartbeat_step || '').includes('等待') ||
                             (task.heartbeat_step || '').includes('恢复') ||
                             (task.heartbeat_step || '').includes('重连') ||
                             (task.heartbeat_step || '').includes('Worker');

      if (timeSinceLastWork > WORK_PROMPT_INTERVAL_MS || isWaitingState) {
        console.log(`🤖 触发智能体工作 | 任务: ${task.title.substring(0, 40)}...`);
        this.lastWorkTime = now;

        // Fix: 在调用 LLM 前只刷新 last_heartbeat，不覆盖 Hermes 的状态
        try {
          await this.framework._sendHeartbeat(task.id, {});
        } catch (hbErr) {
          console.warn(`[Worker] 预发送心跳失败: ${hbErr.message}`);
        }

        const isFirstDrive = !task.expected_duration_minutes;
        const workPrompt = this._buildWorkPrompt(task, isFirstDrive);
        
        try {
          // 记录用户侧活动
          await this._recordActivity('llm_prompt', workPrompt.substring(0, 200), task.id);

          const result = await this.framework.processMessage(workPrompt, [], { executionMode: true });
          const reply = result.response.message;
          
          // 记录智能体回复活动
          await this._recordActivity('llm_reply', reply.substring(0, 500), task.id);
          
          // 执行回复中的 bash 命令（不覆盖 Hermes 的心跳状态）
          await this._processExecutionReply(task, reply);
          
          console.log(`✅ 智能体回复: ${reply.substring(0, 100)}...`);
        } catch (err) {
          console.error('❌ 智能体工作失败:', err.message);
          await this._recordActivity('llm_error', `错误: ${err.message}`, task.id);
        }

        // 如果当前任务连续命令失败 2 次以上，切换到下一个 pending 任务
        if (this.consecutiveCmdFailures >= 2) {
          console.log(`⚠️ 任务 ${task.title} 连续 ${this.consecutiveCmdFailures} 次命令失败，尝试切换 focus`);
          this.consecutiveCmdFailures = 0;
          this.currentTaskId = null;
          await this._trySwitchFocus();
          return;
        }
      } else {
        console.log(`[_workLoop] 任务正常执行中，跳过 | step=${task.heartbeat_step?.substring(0, 30)}`);
      }
    } catch (err) {
      console.error('❌ 工作循环错误:', err.message);
    }
  }

  async _executeBashBlocks(task, reply) {
    const blocks = CommandExecutor.extractBashBlocks(reply);
    if (blocks.length === 0) return null;

    const timeoutMs = CommandExecutor.calcTimeout(task);
    const execResults = await CommandExecutor.executeCommands(blocks, {
      timeoutMs,
      cwd: process.env.HOME,
    });

    const summary = execResults.map((r) =>
      `[${r.index}] ${r.success ? '✅' : '❌'} ${r.command}\n${r.output}`
    ).join('\n---\n');
    await this._recordActivity('command_exec', summary, task.id);

    for (const r of execResults) {
      if (r.success) {
        this.consecutiveCmdFailures = 0;
      } else {
        this.consecutiveCmdFailures++;
        console.error(`❌ 命令失败(${this.consecutiveCmdFailures}次连续): ${r.output.substring(0, 100)}`);
      }
    }

    return execResults;
  }

  /**
   * 处理 LLM 执行回复：只执行 bash 命令，不覆盖 Hermes 管理的心跳状态
   */
  async _processExecutionReply(task, reply) {
    try {
      // 执行回复中的 bash 命令
      const execResults = await this._executeBashBlocks(task, reply);

      // 解析预估耗时（供后续参考，但不写入任务字段，避免与 Hermes 冲突）
      const durationMatch = reply.match(/(?:预计总耗时|预计剩余时间)[：:]\s*(\d+)/);
      if (durationMatch) {
        const expectedDuration = parseInt(durationMatch[1]);
        if (expectedDuration > 0 && expectedDuration < 10080) {
          console.log(`[Worker] LLM 预估耗时: ${expectedDuration} 分钟（不写入，由 Hermes 管理）`);
        }
      }

      // 记录执行摘要到 contexts（供 Hermes 读取）
      if (execResults && execResults.length > 0) {
        const summary = execResults.map((r, i) =>
          `[${i + 1}] ${r.success ? '✅' : '❌'} ${r.cmd.substring(0, 60)}`
        ).join('; ');
        console.log(`[Worker] 执行摘要: ${summary}`);
      }
    } catch (err) {
      // 解析失败不影响主流程
    }
  }

  /**
   * 记录智能体活动到 contexts 表
   */
  async _recordActivity(type, content, taskId) {
    try {
      const db = getDb();
      const sessionId = `worker_${this.framework.config.base.agentId}`;
      
      // 直接插入 contexts 表（绕过 Context.create 避免依赖）
      const id = require('uuid').v4();
      db.prepare(`
        INSERT INTO contexts (id, agent_id, session_id, role, content, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        this.framework.config.base.agentId,
        sessionId,
        'system',
        content,
        JSON.stringify({ type, task_id: taskId, source: 'agent-worker' })
      );

      // 清理旧记录
      this._pruneActivities(db, sessionId);
    } catch (err) {
      // 活动记录失败不影响主流程
    }
  }

  /**
   * 清理旧的活动记录
   */
  _pruneActivities(db, sessionId) {
    try {
      const count = db.prepare(`
        SELECT COUNT(*) as cnt FROM contexts 
        WHERE agent_id = ? AND session_id = ?
      `).get(this.framework.config.base.agentId, sessionId).cnt;

      if (count > ACTIVITY_LOG_LIMIT) {
        db.prepare(`
          DELETE FROM contexts 
          WHERE id IN (
            SELECT id FROM contexts 
            WHERE agent_id = ? AND session_id = ?
            ORDER BY created_at ASC
            LIMIT ?
          )
        `).run(this.framework.config.base.agentId, sessionId, count - ACTIVITY_LOG_LIMIT);
      }
    } catch (err) {
      // 忽略清理错误
    }
  }

  /**
   * 根据任务状态构造工作提示 — 提供丰富上下文
   */
  _buildWorkPrompt(task, isFirstDrive = false) {
    const step = task.heartbeat_step || '执行中';
    const progress = task.heartbeat_progress || 0;
    const blockers = Array.isArray(task.heartbeat_blockers)
      ? task.heartbeat_blockers
      : JSON.parse(task.heartbeat_blockers || '[]');
    const attempts = task.attempt_log || [];

    let prompt = `你是 TODO Server 的智能体工作进程。你的职责是**实际执行任务**，而不是只汇报状态。\n\n`;
    prompt += `## 任务信息\n`;
    prompt += `- 任务名称: ${task.title}\n`;
    prompt += `- 当前进度: ${progress}%\n`;
    prompt += `- 当前步骤: ${step}\n`;
    prompt += `- 尝试次数: ${task.attempt_count || 0}/${task.max_attempts || 3}\n`;

    if (task.description) {
      prompt += `\n## 任务详细描述\n${task.description}\n`;
    }
    
    if (blockers.length > 0) {
      prompt += `\n## 阻塞项\n${blockers.map(b => `- ${b}`).join('\n')}\n`;
    }

    if (attempts.length > 0) {
      prompt += `\n## 历史尝试记录\n`;
      attempts.slice(-3).forEach((a, i) => {
        prompt += `${i + 1}. [${a.success ? '成功' : '失败'}] ${a.reason || ''}\n`;
      });
    }

    prompt += `\n## 执行要求\n`;
    if (blockers.length > 0) {
      prompt += `1. 分析阻塞原因并尝试解决\n`;
      prompt += `2. 如果需要运行命令排查问题，直接在回复中输出命令\n`;
    } else {
      prompt += `1. 根据任务描述，**实际执行下一步具体工作**\n`;
      prompt += `2. 如果需要运行 shell 命令，直接在回复中使用 \`\`\`bash 代码块输出命令\n`;
      prompt += `3. 命令会被自动执行，执行结果会返回给你\n`;
      prompt += `4. 根据执行结果继续推进任务\n`;
    }

    prompt += `\n## 回复格式要求\n`;
    prompt += `- 先说明你要执行什么\n`;
    prompt += `- 如果需要运行命令，使用 \`\`\`bash 包裹命令（每块只能有一条命令，最多 3 块）\n`;
    prompt += `- 命令执行后，你会收到输出结果，据此继续下一步\n`;
    prompt += `- 进度: XX%（基于实际完成的工作更新）\n`;
    prompt += `- 步骤: 一句话描述当前在做什么\n`;
    if (isFirstDrive || !task.expected_duration_minutes) {
      prompt += `- 预计总耗时: XX分钟（请根据任务复杂度合理预估，只需数字）\n`;
    } else {
      prompt += `- 预计剩余时间: XX分钟（基于当前进度重新预估，只需数字）\n`;
    }

    if (task.acceptance_criteria) {
      prompt += `\n## 验收标准\n${task.acceptance_criteria}`;
    }

    prompt += `\n\n现在请开始实际执行工作。不要只汇报状态，要输出具体可执行的命令或操作。`;
    return prompt;
  }

  stop() {
    console.log('\n🛑 Agent Worker 停止中...');
    this.isRunning = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.workTimer) clearInterval(this.workTimer);
    console.log('✅ Agent Worker 已停止');
    process.exit(0);
  }
}

// 启动
if (require.main === module) {
  const args = process.argv.slice(2);
  const agentIndex = args.indexOf('--agent');
  const agentId = agentIndex !== -1 && args[agentIndex + 1] ? args[agentIndex + 1] : null;
  
  const worker = new AgentWorker(agentId);
  worker.start().catch(err => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = AgentWorker;
