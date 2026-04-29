const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');

const router = express.Router({ mergeParams: true });

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

router.post('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { title, description, priority, context, tags, dependencies, projectId, position } = req.body;

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

    const todo = Todo.create(agentId, {
      title,
      description,
      priority,
      context,
      tags,
      dependencies,
      projectId,
      parentId: req.body.parentId,
      position,
      acceptanceCriteria: req.body.acceptanceCriteria,
      criteriaConfirmed: req.body.criteriaConfirmed,
      maxAttempts: req.body.maxAttempts
    });

    res.status(201).json({
      success: true,
      data: todo
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
    const { status, priority, tags, limit, offset } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (priority) filters.priority = priority;
    if (tags) filters.tags = tags.split(',').map(t => t.trim());
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

router.delete('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;

    // Idempotent: return success even if already deleted
    Todo.delete(agentId, id);

    res.json({
      success: true,
      message: 'TODO deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete TODO'
    });
  }
});

router.patch('/:id/complete', (req, res) => {
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

    res.json({
      success: true,
      data: todo,
      parent_auto_completed: parentCompleted
    });
  } catch (error) {
    console.error('Error completing TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to complete TODO'
    });
  }
});

router.patch('/:id/status', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Status is required'
      });
    }

    const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Invalid status. Must be one of: pending, in_progress, completed, cancelled'
      });
    }

    if (!Todo.findById(agentId, id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'TODO not found'
      });
    }

    const todo = Todo.updateStatus(agentId, id, status);

    res.json({
      success: true,
      data: todo
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

router.put('/:id', (req, res) => {
  try {
    const { agentId, id } = req.params;
    const { title, description, status, priority, context, tags, dependencies, projectId, position } = req.body;

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

    const todo = Todo.update(agentId, id, {
      title,
      description,
      status,
      priority,
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
      heartbeatBlockers: req.body.heartbeatBlockers
    });

    res.json({
      success: true,
      data: todo
    });
  } catch (error) {
    console.error('Error updating TODO:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update TODO'
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



module.exports = router;
