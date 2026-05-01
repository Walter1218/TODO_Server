const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');
const { buildDrivePrompt, parseHeartbeatReply } = require('../utils/driveHelper');

const router = express.Router({ mergeParams: true });

function getLlmManager(req) {
  const fw = req.app.get('driveFramework');
  return fw && fw.modules ? fw.modules.llmManager : null;
}

router.use((req, res, next) => {
  const { agentId } = req.params;

  if (!Agent.exists(agentId)) {
    return res.status(404).json({
      error: 'Not found',
      message: 'Agent not found'
    });
  }

  next();
});

// Patrol task detector: force critical priority for patrol/inspection tasks
function isPatrolTask(title, tags) {
  if (title && title.includes('巡检')) return true;
  if (Array.isArray(tags) && tags.some(t => t === '巡检' || t === 'patrol')) return true;
  return false;
}

function enforcePatrolPriority(title, tags, priority) {
  if (isPatrolTask(title, tags)) {
    return 'critical';
  }
  return priority;
}

// Schedule format validator: daily | weekly:mon,tue,... | cron:expr | raw cron expr (legacy)
function validateSchedule(schedule) {
  if (!schedule) return null;
  const validDaily = schedule === 'daily';
  const validWeekly = /^weekly:(sun|mon|tue|wed|thu|fri|sat)(,(sun|mon|tue|wed|thu|fri|sat))*$/i.test(schedule);
  const validCron = /^cron:\S+/.test(schedule);
  // Legacy support: raw 5-part cron expression like "0 18 * * *"
  const validLegacyCron = /^\d+\s+\d+\s+\S+\s+\S+\s+\S+$/.test(schedule);
  if (!validDaily && !validWeekly && !validCron && !validLegacyCron) {
    return 'Invalid schedule format. Use: "daily", "weekly:mon,fri", or "cron:0 9 * * *"';
  }
  return null;
}

router.post('/', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { title, description, priority, context, tags, dependencies, projectId, position, schedule, isTemplate, assignedAgentId } = req.body;

    if (!title) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'TODO title is required'
      });
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid priority. Must be one of: low, medium, high, critical'
      });
    }

    if (dependencies !== undefined) {
      if (!Array.isArray(dependencies)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Dependencies must be an array'
        });
      }

      for (const depId of dependencies) {
        if (!Todo.findById(agentId, depId)) {
          return res.status(400).json({
            error: 'Validation error',
            message: `Dependency todo not found: ${depId}`
          });
        }
      }

      for (const depId of dependencies) {
        if (Todo.hasCircularDependency(agentId, 'new-todo', [depId])) {
          return res.status(400).json({
            error: 'Validation error',
            message: `Circular dependency detected for dependency: ${depId}`
          });
        }
      }
    }

    if (schedule) {
      const schedErr = validateSchedule(schedule);
      if (schedErr) {
        return res.status(400).json({ error: 'Validation error', message: schedErr });
      }
    }

    // Auto-create target agent if assignedAgentId provided and not exists
    if (assignedAgentId && !Agent.exists(assignedAgentId)) {
      Agent.create({ id: assignedAgentId, name: assignedAgentId, metadata: { auto_created: true } });
    }

    const finalPriority = enforcePatrolPriority(title, tags, priority);

    const todo = Todo.create(agentId, {
      title,
      description,
      priority: finalPriority,
      context,
      tags,
      dependencies,
      projectId,
      parentId: req.body.parentId,
      position,
      acceptanceCriteria: req.body.acceptanceCriteria,
      criteriaConfirmed: req.body.criteriaConfirmed,
      maxAttempts: req.body.maxAttempts,
      schedule,
      isTemplate,
      assignedAgentId
    });

    // 创建任务后自动重新评估聚焦
    const focus = await FocusState.autoFocus(agentId, getLlmManager(req));

    res.status(201).json({
      success: true,
      data: todo,
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error creating TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create TODO'
    });
  }
});

router.get('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { status, priority, tags, limit, offset, projectId, isTemplate, title } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (tags) filters.tags = tags.split(',').map(t => t.trim());
    if (projectId) filters.projectId = projectId;
    if (isTemplate !== undefined) filters.isTemplate = isTemplate === 'true' || isTemplate === '1';
    if (title) filters.title = title;
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);

    const todos = Todo.findAllByAgent(agentId, filters);

    res.json({
      success: true,
      data: todos,
      count: todos.length,
      filters
    });
  } catch (error) {
    console.error('Error fetching TODOs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch TODOs'
    });
  }
});

router.get('/stats', (req, res) => {
  try {
    const { agentId } = req.params;
    const stats = Todo.getStats(agentId);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch stats'
    });
  }
});

router.get('/search', (req, res) => {
  try {
    const { agentId } = req.params;
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Search query parameter "q" is required'
      });
    }

    const todos = Todo.search(agentId, q);

    res.json({
      success: true,
      data: todos,
      count: todos.length,
      query: q
    });
  } catch (error) {
    console.error('Error searching TODOs:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to search TODOs'
    });
  }
});

router.get('/summary', (req, res) => {
  try {
    const { agentId } = req.params;
    const summary = Todo.getContextSummary(agentId);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Error fetching context summary:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch context summary'
    });
  }
});

router.get('/ready', (req, res) => {
  try {
    const { agentId } = req.params;
    const readyTasks = Todo.getReadyTasks(agentId);

    res.json({
      success: true,
      data: readyTasks,
      count: readyTasks.length
    });
  } catch (error) {
    console.error('Error fetching ready tasks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch ready tasks'
    });
  }
});

// --- 定时调度任务路由：查询模板任务 ---
router.get('/templates', (req, res) => {
  try {
    const { agentId } = req.params;
    const templates = Todo.findTemplates(agentId);
    res.json({ success: true, data: templates, count: templates.length });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 多智能体协作路由：查询被指派的任务 ---
router.get('/assigned', (req, res) => {
  try {
    const { agentId } = req.params;
    const tasks = Todo.findAssignedToMe(agentId);
    res.json({ success: true, data: tasks, count: tasks.length });
  } catch (error) {
    console.error('Error fetching assigned tasks:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});
// --- 多智能体协作路由：查询我创建的任务 ---
router.get('/created', (req, res) => {
  try {
    const { agentId } = req.params;
    const tasks = Todo.findCreatedByMe(agentId);
    res.json({ success: true, data: tasks, count: tasks.length });
  } catch (error) {
    console.error('Error fetching created tasks:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});
router.get('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const todo = Todo.findById(agentId, id);

    if (!todo) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error fetching TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch TODO'
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { agentId, id } = req.params;

    // Idempotent: return success even if already deleted
    Todo.delete(agentId, id);

    // 删除任务后自动重新评估聚焦
    const focus = await FocusState.autoFocus(agentId, getLlmManager(req));

    res.json({
      success: true,
      message: 'TODO deleted successfully',
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error deleting TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete TODO'
    });
  }
});

router.patch('/:id/complete', async (req, res) => {
  try {
    const { agentId, id } = req.params;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const todo = Todo.complete(agentId, id);

    // Auto-complete parent if all subtasks done
    const parentCompleted = Todo.checkAndCompleteParent(agentId, id);

    // 完成任务后自动切换到下一个可执行任务
    const focus = await FocusState.autoFocus(agentId, getLlmManager(req));

    res.json({
      success: true,
      data: todo,
      parent_auto_completed: parentCompleted,
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error completing TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to complete TODO'
    });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Status is required'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: pending, in_progress, completed, cancelled, blocked'
      });
    }

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const todo = Todo.updateStatus(agentId, id, status);

    // 状态变更为 completed / in_progress / cancelled 时重新评估聚焦
    let focus = null;
    if (['completed', 'in_progress', 'cancelled'].includes(status)) {
      focus = await FocusState.autoFocus(agentId, getLlmManager(req));
    }

    res.json({
      success: true,
      data: todo,
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error updating TODO status:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update TODO status'
    });
  }
});

router.post('/:id/dependencies', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { dependencyId } = req.body;

    if (!dependencyId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'dependencyId is required'
      });
    }

    const todo = Todo.addDependency(agentId, id, dependencyId);

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error adding dependency:', error);
    const statusCode = error.message.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      error: 'Validation error',
      message: error.message
    });
  }
});

router.delete('/:id/dependencies/:depId', (req, res) => {
  try {
    const { agentId, id, depId } = req.params;

    // Idempotent: return success even if todo or dependency already gone
    const todo = Todo.removeDependency(agentId, id, depId);

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error removing dependency:', error);
    res.status(400).json({
      error: 'Validation error',
      message: error.message
    });
  }
});

router.get('/:id/dependency-tree', (req, res) => {
  try {
    const { agentId, id } = req.params;

    const tree = Todo.getDependencyTree(agentId, id);

    if (!tree) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    res.json({
      success: true,
      data: tree
    });
  } catch (error) {
    console.error('Error fetching dependency tree:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch dependency tree'
    });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { title, description, status, priority, context, tags, dependencies, projectId, position, schedule, isTemplate } = req.body;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: pending, in_progress, completed, cancelled, blocked'
      });
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid priority. Must be one of: low, medium, high, critical'
      });
    }

    if (dependencies !== undefined) {
      if (!Array.isArray(dependencies)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Dependencies must be an array'
        });
      }

      for (const depId of dependencies) {
        if (!Todo.findById(agentId, depId)) {
          return res.status(400).json({
            error: 'Validation error',
            message: `Dependency todo not found: ${depId}`
          });
        }
      }

      if (Todo.hasCircularDependency(agentId, id, dependencies)) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Circular dependency detected'
        });
      }
    }

    if (schedule !== undefined) {
      const schedErr = validateSchedule(schedule);
      if (schedErr) {
        return res.status(400).json({ error: 'Validation error', message: schedErr });
      }
    }

    // For updates, check both the incoming title/tags and the existing task
    const existingTask = Todo.findById(agentId, id);
    const checkTitle = title !== undefined ? title : existingTask?.title;
    const checkTags = tags !== undefined ? tags : existingTask?.tags;
    const finalPriority = enforcePatrolPriority(checkTitle, checkTags, priority);

    const todo = Todo.update(agentId, id, {
      title,
      description,
      status,
      priority: finalPriority,
      context,
      tags,
      dependencies,
      projectId,
      parentId: req.body.parentId,
      position,
      acceptanceCriteria: req.body.acceptanceCriteria,
      criteriaConfirmed: req.body.criteriaConfirmed,
      maxAttempts: req.body.maxAttempts,
      attemptCount: req.body.attemptCount,
      attemptLog: req.body.attemptLog,
      heartbeatProgress: req.body.heartbeatProgress,
      heartbeatStep: req.body.heartbeatStep,
      heartbeatBlockers: req.body.heartbeatBlockers,
      schedule,
      isTemplate
    });

    // 如果状态发生变化，重新评估聚焦
    let focus = null;
    if (status !== undefined) {
      focus = await FocusState.autoFocus(agentId, getLlmManager(req));
    }

    res.json({
      success: true,
      data: todo,
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error updating TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update TODO'
    });
  }
});

// --- 定时调度任务路由：手动触发模板实例化 ---
router.post('/:id/spawn', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const todo = Todo.findById(agentId, id);
    if (!todo) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }
    if (!todo.is_template) {
      return res.status(400).json({ error: 'Validation error', message: 'Task is not a template' });
    }

    const spawned = Todo.spawnFromTemplate(agentId, id);

    // Auto-focus after spawning
    const focus = await FocusState.autoFocus(agentId, getLlmManager(req));

    res.json({
      success: true,
      data: { template: todo, spawned },
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error spawning from template:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 手动驱动任务路由：强行触发智能体执行 ---
router.post('/:id/drive', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const todo = Todo.findById(agentId, id);
    if (!todo) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    if (todo.status === 'completed' || todo.status === 'cancelled') {
      return res.status(400).json({ error: 'Validation error', message: 'Task is already completed or cancelled' });
    }

    // 1. 状态处理
    if (todo.status === 'blocked') {
      const maxAttempts = todo.max_attempts || 3;
      const currentAttempts = todo.attempt_count || 0;
      if (currentAttempts >= maxAttempts) {
        return res.status(400).json({
          error: 'Validation error',
          message: `Task has reached max attempts (${maxAttempts})`
        });
      }
      // 恢复为 in_progress
      Todo.update(agentId, id, {
        status: 'in_progress',
        attemptCount: currentAttempts + 1,
        attemptLog: [...(todo.attempt_log || []), {
          timestamp: new Date().toISOString(),
          success: true,
          reason: '用户手动驱动恢复',
          output: 'Manual drive recovery'
        }]
      });
    } else if (todo.status === 'pending') {
      Todo.updateStatus(agentId, id, 'in_progress');
    }

    // 2. 获取 Framework 实例
    const framework = req.app.get('driveFramework');
    if (!framework || !framework.initialized) {
      return res.status(503).json({
        error: 'Service unavailable',
        message: 'Framework not initialized, cannot drive task'
      });
    }

    // 3. 构建 Work Prompt
    const refreshedTask = Todo.findById(agentId, id);
    const workPrompt = buildDrivePrompt(refreshedTask, { isManual: true });

    // 4. 调用 LLM
    const result = await framework.processMessage(workPrompt);
    const reply = result.response.message;

    // 5. 解析回复并更新心跳
    const parsed = parseHeartbeatReply(refreshedTask, reply);
    if (parsed.changed) {
      Todo.updateHeartbeat(agentId, id, {
        progress: parsed.progress,
        step: parsed.step,
        blockers: parsed.blockers
      });
    }

    // 6. 写入 contexts 记录
    Context.create(agentId, {
      sessionId: 'manual-drive',
      role: 'system',
      content: `[手动驱动] 任务「${refreshedTask.title}」被执行\n\n智能体回复:\n${reply.substring(0, 500)}`,
      metadata: { type: 'manual_drive', task_id: id, reply_length: reply.length }
    });

    // 7. 返回结果
    res.json({
      success: true,
      data: {
        task: Todo.findById(agentId, id),
        llm_reply: reply,
        heartbeat_updated: parsed.changed,
        parsed: { progress: parsed.progress, step: parsed.step, blockers: parsed.blockers }
      }
    });
  } catch (error) {
    console.error('Error driving task:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to drive task'
    });
  }
});

// --- 新增路由：心跳更新 ---
router.post('/:id/heartbeat', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { progress, step, blockers } = req.body;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    const todo = Todo.updateHeartbeat(agentId, id, { progress, step, blockers });
    res.json({ success: true, data: todo });
  } catch (error) {
    console.error('Error updating heartbeat:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 新增路由：记录尝试 ---
router.post('/:id/attempt', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { success, reason, output } = req.body;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    const todo = Todo.recordAttempt(agentId, id, { success, reason, output });

    // If blocked after max attempts, include that info
    const isBlocked = todo.status === 'blocked';

    res.json({
      success: true,
      data: todo,
      blocked: isBlocked,
      message: isBlocked ? '任务已达到最大重试次数，已标记为阻塞' : undefined
    });
  } catch (error) {
    console.error('Error recording attempt:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 新增路由：获取子任务 ---
router.get('/:id/subtasks', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const subtasks = Todo.findSubtasks(agentId, id);
    res.json({ success: true, data: subtasks, count: subtasks.length });
  } catch (error) {
    console.error('Error fetching subtasks:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 新增路由：安全追加子任务（方案重构时拆分工作项） ---
router.post('/:id/sub-tasks', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { title, description, priority, context, tags, assignedAgentId } = req.body;

    // 验证父任务存在
    const parent = Todo.findById(agentId, id);
    if (!parent) {
      return res.status(404).json({ error: 'Not found', message: 'Parent TODO not found' });
    }

    if (!title) {
      return res.status(400).json({ error: 'Validation error', message: 'Sub-task title is required' });
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    if (priority && !validPriorities.includes(priority)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid priority. Must be one of: low, medium, high, critical'
      });
    }

    // 自动创建目标 agent（如果指定了且不存在）
    if (assignedAgentId && !Agent.exists(assignedAgentId)) {
      Agent.create({ id: assignedAgentId, name: assignedAgentId, metadata: { auto_created: true } });
    }

    // 子任务继承父任务的项目ID，优先级默认与父任务相同
    const subtask = Todo.create(agentId, {
      title,
      description,
      priority: priority || parent.priority || 'medium',
      context,
      tags: tags || [],
      parentId: id,
      projectId: parent.project_id,
      assignedAgentId
    });

    // 更新父任务心跳，记录新增了子任务
    Todo.updateHeartbeat(agentId, id, {
      step: parent.heartbeat_step || '进行中',
      blockers: [...(parent.heartbeat_blockers || []), `新增子任务: ${title}`]
    });

    res.status(201).json({
      success: true,
      data: subtask,
      message: '子任务已创建'
    });
  } catch (error) {
    console.error('Error creating sub-task:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 新增路由：获取卡住的任务（无心跳超时） ---
router.get('/stuck/list', (req, res) => {
  try {
    const { agentId } = req.params;
    const maxIdleMinutes = parseInt(req.query.maxIdleMinutes) || 30;
    const stuckTasks = Todo.findStuckTasks(agentId, maxIdleMinutes);
    res.json({ success: true, data: stuckTasks, count: stuckTasks.length });
  } catch (error) {
    console.error('Error fetching stuck tasks:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 多智能体协作路由：指派任务 ---
router.post('/:id/assign', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { assignedAgentId, targetAgentId, note } = req.body;
    const targetId = assignedAgentId || targetAgentId;

    if (!targetId) {
      return res.status(400).json({ error: 'Validation error', message: 'assignedAgentId or targetAgentId is required' });
    }

    // Auto-create target agent if not exists
    if (!Agent.exists(targetId)) {
      Agent.create({ id: targetId, name: targetId, metadata: { auto_created: true } });
    }

    const todo = Todo.assign(agentId, id, targetId, note || '');

    // 创建通知给被指派的 agent
    const Notification = require('../models/Notification');
    Notification.create(targetId, id, 'assigned',
      `你被指派了任务：${todo.title}${note ? ' — ' + note : ''}`
    );

    res.json({ success: true, data: todo, message: '任务已指派' });
  } catch (error) {
    console.error('Error assigning task:', error);
    res.status(400).json({ error: 'Validation error', message: error.message });
  }
});

// --- 多智能体协作路由：转交任务 ---
router.post('/:id/transfer', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { newAssignedAgentId, targetAgentId, note, reason } = req.body;
    const targetId = newAssignedAgentId || targetAgentId;
    const transferNote = note || reason || '';

    if (!targetId) {
      return res.status(400).json({ error: 'Validation error', message: 'newAssignedAgentId or targetAgentId is required' });
    }

    // Auto-create target agent if not exists
    if (!Agent.exists(targetId)) {
      Agent.create({ id: targetId, name: targetId, metadata: { auto_created: true } });
    }

    const todo = Todo.transfer(agentId, id, targetId, transferNote);

    // 创建通知
    const Notification = require('../models/Notification');
    Notification.create(targetId, id, 'transferred',
      `任务「${todo.title}」被转交给你${transferNote ? '，原因：' + transferNote : ''}`
    );

    res.json({ success: true, data: todo, message: '任务已转交' });
  } catch (error) {
    console.error('Error transferring task:', error);
    res.status(400).json({ error: 'Validation error', message: error.message });
  }
});



// --- 管理路由：手动归档旧任务 ---
router.post('/archive-old', (req, res) => {
  try {
    const { agentId } = req.params;
    const daysOld = parseInt(req.query.days) || 30;
    const archived = Todo.archiveOldCompleted(agentId, daysOld);
    res.json({ success: true, archived, message: `已归档 ${archived} 个超过 ${daysOld} 天的旧任务` });
  } catch (error) {
    console.error('Error archiving old tasks:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// --- 管理路由：物理删除已归档任务 ---
router.delete('/archived', (req, res) => {
  try {
    const { agentId } = req.params;
    const deleted = Todo.purgeArchived(agentId);
    res.json({ success: true, deleted, message: `已删除 ${deleted} 个已归档任务` });
  } catch (error) {
    console.error('Error purging archived tasks:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
