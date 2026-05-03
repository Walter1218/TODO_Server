const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const { buildDrivePrompt, parseHeartbeatReply } = require('../utils/driveHelper');
const CommandExecutor = require('../services/CommandExecutor');
const ProgressValidator = require('../services/ProgressValidator');

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

    const { getDb } = require('../db');
    if (!isTemplate) {
      const activeDup = getDb().prepare(`
        SELECT id, status, priority, created_at FROM todos
        WHERE agent_id = ? AND title = ? AND archived = 0
          AND status NOT IN ('completed', 'cancelled')
        LIMIT 1
      `).get(agentId, title);
      if (activeDup) {
        return res.status(409).json({
          error: 'Conflict',
          message: `同 agent 下已存在同名进行中任务（${activeDup.status}），请复用已有任务或更改标题`,
          existing_task: { id: activeDup.id, status: activeDup.status, priority: activeDup.priority, created_at: activeDup.created_at }
        });
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
    const { status, priority, tags, limit, offset, projectId, isTemplate, title, source } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (tags) filters.tags = tags.split(',').map(t => t.trim());
    if (projectId) filters.projectId = projectId;
    if (isTemplate !== undefined) filters.isTemplate = isTemplate === 'true' || isTemplate === '1';
    if (title) filters.title = title;
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);
    if (source) filters.source = source;

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

router.get('/agent-tasks', (req, res) => {
  try {
    const { agentId } = req.params;
    const { status, priority, limit, offset } = req.query;

    const filters = { source: 'agent' };
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (limit) filters.limit = parseInt(limit);
    if (offset) filters.offset = parseInt(offset);

    const todos = Todo.findAllByAgent(agentId, filters);

    const enhanced = todos.map(t => {
      const isExecuting = t.last_heartbeat && (Date.now() - new Date(t.last_heartbeat).getTime()) < 300000;
      return {
        ...t,
        _isAgentExecuting: isExecuting,
        _executingAgent: isExecuting ? t.assigned_agent_id || t.origin_agent_id : null
      };
    });

    res.json({
      success: true,
      data: enhanced,
      count: enhanced.length
    });
  } catch (error) {
    console.error('Error fetching agent tasks:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch agent tasks'
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

// --- 定时调度路由：查询待执行的模板实例 ---
router.get('/scheduled/pending', (req, res) => {
  try {
    const { agentId } = req.params;
    const templates = Todo.findTemplates(agentId);
    const result = [];

    for (const template of templates) {
      const pendingTasks = Todo.findPendingByTemplate(agentId, template.id);
      if (pendingTasks.length > 0) {
        result.push({
          template_id: template.id,
          template_title: template.title,
          schedule: template.schedule,
          pending_tasks: pendingTasks.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description,
            context: t.context,
            created_at: t.created_at
          }))
        });
      }
    }

    res.json({ success: true, data: result, count: result.reduce((s, r) => s + r.pending_tasks.length, 0) });
  } catch (error) {
    console.error('Error fetching scheduled pending tasks:', error);
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
    const forceComplete = String(req.query.force || '').toLowerCase() === 'true'
      || String(req.query.force || '') === '1'
      || String(req.headers['x-force-complete'] || '').toLowerCase() === 'true';

    const existing = Todo.findById(agentId, id);
    if (!existing) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    if (!forceComplete) {
      Todo.update(agentId, id, {
        status: 'pending_validation',
        heartbeatProgress: 100,
        heartbeatStep: '🧾 已提交验收申请（待自动校验）'
      });

      Context.create(agentId, {
        sessionId: 'completion-proposal',
        role: 'system',
        content: `[complete->pending_validation] 任务「${existing.title}」触发自动验收流程（可用 ?force=true 跳过）`,
        metadata: { type: 'task_completion_proposal', task_id: id }
      });

      return res.json({
        success: true,
        data: Todo.findById(agentId, id),
        status_rewritten: true,
        note: '已将 completed 请求重写为 pending_validation，以触发内嵌智能体自动验收。需要强制完成可使用 ?force=true 或 X-Force-Complete: true'
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
    const forceComplete = String(req.query.force || '').toLowerCase() === 'true'
      || String(req.query.force || '') === '1'
      || String(req.headers['x-force-complete'] || '').toLowerCase() === 'true';

    if (!status) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Status is required'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'pending_validation', 'validation_failed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
      });
    }

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const todo = Todo.findById(agentId, id);

    const appliedStatus = (status === 'completed' && !forceComplete) ? 'pending_validation' : status;

    if (appliedStatus === 'completed') {
      const unmetCriteria = [];
      if (todo.acceptance_criteria && !todo.criteria_confirmed) {
        const criteria = todo.acceptance_criteria.split('\n').filter(l => l.trim());
        const confirmedSet = new Set(
          (todo.criteria_met || '').split('\n').filter(l => l.trim())
        );
        for (const c of criteria) {
          if (c.trim() && !confirmedSet.has(c.trim())) {
            unmetCriteria.push(c.trim());
          }
        }
      }
      if (unmetCriteria.length > 0) {
        return res.status(409).json({
          error: 'Acceptance criteria not met',
          message: '任务有未满足的验收标准，请先通过工具调用 confirmCompletion 或明确标注 criteriaConfirmed',
          unmet_criteria: unmetCriteria,
          tip: '调用 POST /:id/confirm-completion 明确完成任务并声明满足的标准'
        });
      }
    }

    const updatedTodo = Todo.updateStatus(agentId, id, appliedStatus);

    // 状态变更为 completed / in_progress / cancelled 时重新评估聚焦
    let focus = null;
    if (['completed', 'in_progress', 'cancelled'].includes(appliedStatus)) {
      focus = await FocusState.autoFocus(agentId, getLlmManager(req));
    }

    res.json({
      success: true,
      data: updatedTodo,
      status_rewritten: status === 'completed' && appliedStatus === 'pending_validation',
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
    const { title, description, status, priority, context, tags, dependencies, projectId, position, schedule, isTemplate, assignedAgentId } = req.body;
    const assignedAgentIdCompat = req.body.assigned_agent_id;
    const assignmentNote = req.body.assignmentNote !== undefined ? req.body.assignmentNote : req.body.assignment_note;
    const normalizedAssignedAgentId = assignedAgentId !== undefined ? assignedAgentId : assignedAgentIdCompat;

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled', 'blocked', 'pending_validation', 'validation_failed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
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

    if (normalizedAssignedAgentId !== undefined || assignmentNote !== undefined) {
      if (!existingTask?.is_template) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'assigned_agent_id 不支持通过 PUT /todos/:id 直接更新。请使用 POST /todos/:id/assign 或 POST /todos/:id/transfer；模板任务（is_template=true）例外可通过 PUT 设置默认执行者。'
        });
      }
      if (normalizedAssignedAgentId && !Agent.exists(normalizedAssignedAgentId)) {
        Agent.create({ id: normalizedAssignedAgentId, name: normalizedAssignedAgentId, metadata: { auto_created: true } });
      }
    }

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
      assignedAgentId: normalizedAssignedAgentId,
      assignmentNote,
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

    // 3. 执行前快照
    const refreshedTask = Todo.findById(agentId, id);
    const before = ProgressValidator.snapshot(refreshedTask);

    // 4. 构建 Work Prompt
    const workPrompt = buildDrivePrompt(refreshedTask, { isManual: true });

    // 5. 调用 LLM
    const result = await framework.processMessage(workPrompt);
    const reply = result.response.message;

    // 6. 【增强】提取并执行 bash 命令
    let commandsExecuted = [];
    const { commands, results } = await CommandExecutor.extractAndRun(reply, { task: refreshedTask });
    if (commands.length > 0) {
      commandsExecuted = results || [];
      Context.create(agentId, {
        sessionId: 'manual-drive',
        role: 'system',
        content: `[手动驱动] 命令执行结果:\n${CommandExecutor.buildExecutionSummary(commandsExecuted)}`,
        metadata: { type: 'command_exec', task_id: id, commands_count: commands.length }
      });
    }

    // 7. 解析 heartbeat 变更（结合命令执行结果）
    const parsed = parseHeartbeatReply(refreshedTask, reply);
    if (parsed.changed) {
      Todo.updateHeartbeat(agentId, id, {
        progress: parsed.progress,
        step: parsed.step,
        blockers: parsed.blockers
      });
    }

    // 8. 更新 last_driven_at
    const { getDb } = require('../db');
    getDb().prepare(`UPDATE todos SET last_driven_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

    // 9. 【新增】Progress 验证
    const afterRefreshed = Todo.findById(agentId, id);
    const after = ProgressValidator.snapshot(afterRefreshed);
    const { changed } = ProgressValidator.compare(before, after);

    const progressReport = ProgressValidator.buildReport(id, before, after, { success: changed, attempts: 1 });
    Context.create(agentId, {
      sessionId: 'manual-drive',
      role: 'system',
      content: `[手动驱动] ${progressReport}`,
      metadata: { type: 'progress_report', task_id: id }
    });

    // 10. 写入 contexts 记录
    Context.create(agentId, {
      sessionId: 'manual-drive',
      role: 'system',
      content: `[手动驱动] 任务「${refreshedTask.title}」被执行\n\n智能体回复:\n${reply.substring(0, 500)}`,
      metadata: { type: 'manual_drive', task_id: id, reply_length: reply.length }
    });

    // 11. 返回结果
    res.json({
      success: true,
      data: {
        task: Todo.findById(agentId, id),
        llm_reply: reply,
        heartbeat_updated: parsed.changed,
        commands_executed: commandsExecuted,
        progress_changed: changed,
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

// --- 显式完成路由：带验收标准确认 ---
router.post('/:id/confirm-completion', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { summary, criteriaMet, evidence } = req.body;
    const forceComplete = String(req.query.force || '').toLowerCase() === 'true'
      || String(req.query.force || '') === '1'
      || String(req.headers['x-force-complete'] || '').toLowerCase() === 'true';

    const todo = Todo.findById(agentId, id);
    if (!todo) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }
    if (todo.status === 'completed' || todo.status === 'cancelled') {
      return res.status(400).json({ error: 'Validation error', message: 'Task is already completed or cancelled' });
    }

    if (todo.acceptance_criteria && (!criteriaMet || criteriaMet.length === 0)) {
      return res.status(409).json({
        error: 'Acceptance criteria required',
        message: '任务有验收标准，必须提供 criteriaMet 列表',
        acceptance_criteria: todo.acceptance_criteria,
        tip: 'criteriaMet 为字符串数组，每项对应 acceptance_criteria 中的一条'
      });
    }

    const criteriaText = criteriaMet
      ? criteriaMet.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '';

    Todo.update(agentId, id, {
      status: forceComplete ? 'completed' : 'pending_validation',
      criteriaConfirmed: true,
      description: todo.description
        ? `${todo.description}\n\n## 完成摘要\n${summary || ''}\n\n## 验收标准满足情况\n${criteriaText}\n\n## 验收证据\n${evidence || ''}`
        : `\n## 完成摘要\n${summary || ''}\n\n## 验收标准满足情况\n${criteriaText}\n\n## 验收证据\n${evidence || ''}`,
      heartbeatProgress: 100,
      heartbeatStep: forceComplete ? '✅ 已完成（强制完成）' : '🧾 已提交验收申请（待自动校验）'
    });

    Context.create(agentId, {
      sessionId: 'confirm-completion',
      role: 'system',
      content: forceComplete
        ? `[confirm-completion] 任务「${todo.title}」被强制标记为完成，criteriaMet=${JSON.stringify(criteriaMet || [])}`
        : `[confirm-completion] 任务「${todo.title}」提交验收申请，criteriaMet=${JSON.stringify(criteriaMet || [])}`,
      metadata: { type: forceComplete ? 'task_force_completion' : 'task_completion_proposal', task_id: id, criteria_met: criteriaMet || [], summary }
    });

    const parentCompleted = forceComplete ? Todo.checkAndCompleteParent(agentId, id) : false;
    const focus = forceComplete ? await FocusState.autoFocus(agentId, getLlmManager(req)) : null;

    res.json({
      success: true,
      data: Todo.findById(agentId, id),
      parent_auto_completed: parentCompleted,
      status_rewritten: !forceComplete,
      focus: focus ? { task: focus, focus_reason: focus.focus_reason } : null
    });
  } catch (error) {
    console.error('Error confirming task completion:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
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
router.post('/:id/assign', async (req, res) => {
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

    Notification.create(targetId, id, 'assigned',
      `你被指派了任务：${todo.title}${note ? ' — ' + note : ''}`
    );

    try {
      const focus = await FocusState.autoFocus(targetId, getLlmManager(req));
      if (focus) {
        Context.create(targetId, {
          sessionId: 'assignment-driver',
          role: 'system',
          content: `[AssignmentDriver] 任务「${todo.title}」被指派后自动聚焦到: ${focus.title}（原因: ${focus.focus_reason}）`,
          metadata: { type: 'assignment_focus', task_id: id, focus_reason: focus.focus_reason }
        });
      }
    } catch (focusErr) {
      console.warn(`[Assign] auto-focus for ${targetId} failed: ${focusErr.message}`);
    }

    res.json({ success: true, data: todo, message: '任务已指派' });
  } catch (error) {
    console.error('Error assigning task:', error);
    res.status(400).json({ error: 'Validation error', message: error.message });
  }
});

// --- 多智能体协作路由：转交任务 ---
router.post('/:id/transfer', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { newAssignedAgentId, targetAgentId, note, reason } = req.body;
    const targetId = newAssignedAgentId || targetAgentId;
    const transferNote = note || reason || '';

    if (!targetId) {
      return res.status(400).json({ error: 'Validation error', message: 'newAssignedAgentId or targetAgentId is required' });
    }

    if (!Agent.exists(targetId)) {
      Agent.create({ id: targetId, name: targetId, metadata: { auto_created: true } });
    }

    const todo = Todo.transfer(agentId, id, targetId, transferNote);

    Notification.create(targetId, id, 'transferred',
      `任务「${todo.title}」被转交给你${transferNote ? '，原因：' + transferNote : ''}`
    );

    try {
      const focus = await FocusState.autoFocus(targetId, getLlmManager(req));
      if (focus) {
        Context.create(targetId, {
          sessionId: 'assignment-driver',
          role: 'system',
          content: `[AssignmentDriver] 任务「${todo.title}」被转交后自动聚焦到: ${focus.title}（原因: ${focus.focus_reason}）`,
          metadata: { type: 'transfer_focus', task_id: id, focus_reason: focus.focus_reason }
        });
      }
    } catch (focusErr) {
      console.warn(`[Transfer] auto-focus for ${targetId} failed: ${focusErr.message}`);
    }

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

// --- 定时调度路由：cron job 执行完后写入报告到模板实例 ---
router.post('/:id/report', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { status, description, context, heartbeatProgress, heartbeatStep, heartbeatBlockers } = req.body;
    const forceComplete = String(req.query.force || '').toLowerCase() === 'true'
      || String(req.query.force || '') === '1'
      || String(req.headers['x-force-complete'] || '').toLowerCase() === 'true';

    const todo = Todo.findById(agentId, id);
    if (!todo) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    const appliedStatus = (status === 'completed' && !forceComplete) ? 'pending_validation' : status;
    const appliedHeartbeatStep = (status === 'completed' && !forceComplete)
      ? '🧾 已提交验收申请（待自动校验）'
      : heartbeatStep;

    const updated = Todo.writeReport(agentId, id, {
      status: appliedStatus,
      description,
      context,
      heartbeatProgress,
      heartbeatStep: appliedHeartbeatStep,
      heartbeatBlockers
    });

    Context.create(agentId, {
      sessionId: 'scheduled-report',
      role: 'system',
      content: `[CronReport] 任务「${todo.title}」已接收执行报告（status=${appliedStatus || 'unchanged'}）`,
      metadata: { type: 'cron_report', task_id: id, template_id: todo.parent_id }
    });

    res.json({ success: true, data: updated, status_rewritten: status === 'completed' && appliedStatus === 'pending_validation' });
  } catch (error) {
    console.error('Error writing report:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

router.post('/:id/validation-report', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { validatorAgentId, pass, reason, feedback, score } = req.body;

    if (validatorAgentId === undefined || pass === undefined || score === undefined) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Missing required fields: validatorAgentId, pass, score'
      });
    }

    const task = Todo.findById(agentId, id);
    if (!task) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    const newValidationCount = (task.validation_count || 0) + 1;
    const updateData = {
      validationCount: newValidationCount,
      validationReport: JSON.stringify({ pass, reason, feedback, score, validatorAgentId }),
      validatedBy: validatorAgentId
    };

    if (pass) {
      updateData.status = 'completed';
      updateData.heartbeatStep = '✅ 第三方验证通过';
    } else {
      updateData.status = 'validation_failed';
      updateData.heartbeatStep = `❌ 第三方验证未通过: ${reason}`;
    }

    const updated = Todo.update(agentId, id, updateData);

    Context.create(agentId, {
      sessionId: 'validation-report',
      role: 'system',
      content: `[ThirdPartyValidation] 验证报告来自 ${validatorAgentId}：${pass ? '✅ 通过' : '❌ 失败'}（评分 ${score}）\n原因：${reason}\n反馈：${feedback || '无'}`,
      metadata: { type: 'third_party_validation_report', task_id: id, validator: validatorAgentId, pass, score }
    });

    // 查找并更新验证任务（validatorAgentId 的验证任务，验证当前任务）
    const db = require('../db').getDb();
    const allValidationTasks = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ?
        AND title LIKE '[验证]%'
        AND status = 'validating'
    `).all(validatorAgentId);
    
    // 精确匹配 originalTaskId
    const validationTasks = allValidationTasks.filter(vt => {
      try {
        const vtCtx = JSON.parse(vt.context || '{}');
        return vtCtx.originalTaskId === id;
      } catch (e) {
        return false;
      }
    });
    
    for (const vt of validationTasks) {
      Todo.update(validatorAgentId, vt.id, {
        status: 'completed',
        heartbeatStep: pass ? '✅ 验证任务已完成' : `❌ 验证任务已完成（未通过）`
      });
      console.log(`[ThirdPartyValidation] 验证任务 ${vt.id} 已更新为 completed`);
    }

    if (pass) {
      Todo.checkAndCompleteParent(agentId, id);

      const TaskReportService = require('../services/TaskReportService');
      const report = await TaskReportService.generateReport(agentId, id);
      const reportMarkdown = TaskReportService.formatMarkdownReport(report);

      Context.create(agentId, {
        sessionId: 'task-report',
        role: 'system',
        content: `[TaskReport] 任务流程报告已自动生成\n\n${reportMarkdown}`,
        metadata: { type: 'task_report_auto', task_id: id, report_generated_at: new Date().toISOString() }
      });

      console.log(`[TaskReport] 任务 ${id} 流程报告已自动生成`);
    }

    console.log(`[ThirdPartyValidation] 验证报告已接收: task=${id}, validator=${validatorAgentId}, pass=${pass}, score=${score}`);
    res.json({ success: true, data: updated });

  } catch (error) {
    console.error('Error processing validation report:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

router.get('/:id/report', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { format } = req.query;

    const TaskReportService = require('../services/TaskReportService');

    const report = await TaskReportService.generateReport(agentId, id);

    if (format === 'markdown') {
      const markdown = TaskReportService.formatMarkdownReport(report);
      res.type('text/markdown').send(markdown);
    } else {
      res.json({ success: true, data: report });
    }
  } catch (error) {
    console.error('Error generating task report:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

router.get('/:id/context', async (req, res) => {
  try {
    const { agentId, id } = req.params;

    const task = Todo.findById(agentId, id);
    if (!task) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    const contexts = Context.findBySession(agentId, id);
    const notifications = Notification.findByTask(agentId, id);

    let parentContext = null;
    if (task.context) {
      try {
        parentContext = JSON.parse(task.context);
      } catch (e) {
        parentContext = { raw: task.context };
      }
    }

    res.json({
      success: true,
      data: {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority,
          tags: (() => {
            try {
              return task.tags ? JSON.parse(task.tags) : [];
            } catch (e) {
              return [];
            }
          })(),
          acceptance_criteria: task.acceptance_criteria,
          context: parentContext
        },
        history: contexts.map(c => ({
          role: c.role,
          content: c.content,
          timestamp: c.created_at,
          sessionId: c.session_id,
          metadata: (() => {
            try {
              return c.metadata ? JSON.parse(c.metadata) : null;
            } catch (e) {
              return null;
            }
          })()
        })),
        notifications: notifications.map(n => ({
          type: n.type,
          message: n.message,
          timestamp: n.created_at,
          read: n.read_at !== null
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching task context:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

router.post('/:id/request-help', async (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { issue, whatTried, urgency } = req.body;

    if (!issue) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Missing required field: issue'
      });
    }

    const task = Todo.findById(agentId, id);
    if (!task) {
      return res.status(404).json({ error: 'Not found', message: 'TODO not found' });
    }

    Context.create(agentId, {
      sessionId: id,
      role: 'system',
      content: `[RequestHelp] 智能体请求帮助\n问题：${issue}\n已尝试方法：${whatTried || '无'}\n紧迫程度：${urgency || 'normal'}`,
      metadata: JSON.stringify({
        type: 'help_request',
        task_id: id,
        urgency: urgency || 'normal',
        what_tried: whatTried
      })
    });

    Notification.create(agentId, id, 'comment',
      `🆘 请求帮助：${issue.slice(0, 50)}...`
    );

    res.json({
      success: true,
      message: 'Help request submitted. A human operator will review and respond.',
      data: {
        taskId: id,
        issue,
        whatTried,
        submittedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error processing help request:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
