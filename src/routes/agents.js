const express = require('express');
const Agent = require('../models/Agent');
const Context = require('../models/Context');

const router = express.Router();

router.post('/', (req, res) => {
  try {
    const { name, metadata, id } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Agent name is required'
      });
    }

    const agent = Agent.create({ id, name, metadata });

    res.status(201).json({
      success: true,
      data: agent
    });
  } catch (error) {
    console.error('Error creating agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create agent'
    });
  }
});

router.get('/', (req, res) => {
  try {
    const agents = Agent.findAll();

    res.json({
      success: true,
      data: agents,
      count: agents.length
    });
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch agents'
    });
  }
});

router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const agent = Agent.findById(id);

    if (!agent) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Agent not found'
      });
    }

    res.json({
      success: true,
      data: agent
    });
  } catch (error) {
    console.error('Error fetching agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch agent'
    });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, metadata, maxConcurrentTasks } = req.body;

    if (!Agent.exists(id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Agent not found'
      });
    }

    if (maxConcurrentTasks !== undefined && (typeof maxConcurrentTasks !== 'number' || maxConcurrentTasks < 1 || maxConcurrentTasks > 20)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'maxConcurrentTasks must be a number between 1 and 20'
      });
    }

    const agent = Agent.update(id, { name, metadata, maxConcurrentTasks });

    res.json({
      success: true,
      data: agent
    });
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update agent'
    });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;

    // Idempotent: return success even if already deleted
    Agent.delete(id);

    res.json({
      success: true,
      message: 'Agent deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete agent'
    });
  }
});

// POST /api/agents/:id/activity — 报告智能体活动（任何组件可调用）
router.get('/:id/concurrency', (req, res) => {
  try {
    const { id } = req.params;
    if (!Agent.exists(id)) {
      return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
    }
    const status = Agent.canAcceptNewTask(id);
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

router.post('/:id/activity', (req, res) => {
  try {
    const { id } = req.params;
    const { step, progress, status, taskId, metadata = {} } = req.body;

    if (!Agent.exists(id)) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Agent not found'
      });
    }

    // 写入 contexts 作为活动记录
    const content = step || 'Agent activity reported';
    Context.create(id, {
      sessionId: 'agent-activity',
      role: 'system',
      content: content,
      metadata: {
        type: 'agent_activity',
        task_id: taskId || null,
        progress: progress || null,
        status: status || null,
        ...metadata
      }
    });

    // 如果有 taskId 和 progress，同时更新任务心跳
    if (taskId && progress !== undefined) {
      const Todo = require('../models/Todo');
      const todo = Todo.findById(id, taskId);
      if (todo) {
        Todo.updateHeartbeat(id, taskId, {
          step: step || todo.heartbeat_step,
          progress: progress
        });
      }
    }

    res.json({
      success: true,
      message: 'Activity recorded'
    });
  } catch (error) {
    console.error('Error recording activity:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to record activity'
    });
  }
});

module.exports = router;
