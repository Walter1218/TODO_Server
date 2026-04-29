const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  const { agentId } = req.params;
  if (!Agent.exists(agentId)) {
    return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
  }
  next();
});

// GET /api/agents/:agentId/focus — 获取当前聚焦状态 + 任务详情
router.get('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const context = FocusState.getFocusContext(agentId);

    if (!context || !context.current_task) {
      return res.json({
        success: true,
        data: null,
        message: '当前没有聚焦的任务'
      });
    }

    // Build human-readable focus message
    const task = context.current_task;
    const parent = context.parent_task;
    const subtasks = context.subtasks;

    let message = `📋 当前任务聚焦\n\n`;
    if (parent) {
      message += `主任务：${parent.title} (${parent.status})\n`;
      message += `当前子任务：${task.title} (${subtasks.findIndex(s => s.id === task.id) + 1}/${subtasks.length})\n\n`;
    } else {
      message += `任务：${task.title}\n`;
      if (subtasks.length > 0) {
        message += `子任务：${subtasks.length} 个\n`;
      }
      message += `\n`;
    }

    message += `状态：${task.status}\n`;
    message += `优先级：${task.priority}\n`;

    if (task.acceptance_criteria) {
      message += `\n验收标准：\n${task.acceptance_criteria}\n`;
    }

    if (task.heartbeat_progress > 0) {
      message += `\n进度：${Math.round(task.heartbeat_progress * 100)}%\n`;
    }
    if (task.heartbeat_step) {
      message += `当前步骤：${task.heartbeat_step}\n`;
    }

    if (subtasks.length > 0) {
      const done = subtasks.filter(s => s.status === 'completed').length;
      message += `\n子任务进度：${done}/${subtasks.length} 完成\n`;
      subtasks.forEach((s, i) => {
        const icon = s.status === 'completed' ? '✅' : s.status === 'in_progress' ? '⚡' : '⬜';
        message += `  ${icon} ${i + 1}. ${s.title}\n`;
      });
    }

    if (task.attempt_count > 0) {
      message += `\n尝试次数：${task.attempt_count}/${task.max_attempts}\n`;
    }

    res.json({
      success: true,
      data: {
        focus_state: context.focus_state,
        current_task: task,
        parent_task: parent,
        subtasks: subtasks,
        siblings: context.siblings,
        focus_message: message
      }
    });
  } catch (error) {
    console.error('Error fetching focus:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// PUT /api/agents/:agentId/focus — 手动设置聚焦任务
router.put('/', (req, res) => {
  try {
    const { agentId } = req.params;
    const { taskId, focusMode, contextWindowSize } = req.body;

    if (taskId) {
      const todo = Todo.findById(agentId, taskId);
      if (!todo) {
        return res.status(404).json({ error: 'Not found', message: 'Task not found' });
      }
    }

    const state = FocusState.createOrUpdate(agentId, {
      currentTaskId: taskId || null,
      focusMode: focusMode || 'manual',
      contextWindowSize: contextWindowSize || 10
    });

    res.json({ success: true, data: state });
  } catch (error) {
    console.error('Error updating focus:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// POST /api/agents/:agentId/focus/auto — 自动聚焦（由 Focus Engine 选择）
router.post('/auto', (req, res) => {
  try {
    const { agentId } = req.params;
    const chosen = FocusState.autoFocus(agentId);

    if (!chosen) {
      return res.json({
        success: true,
        data: null,
        message: '没有可聚焦的任务'
      });
    }

    res.json({
      success: true,
      data: {
        task: chosen,
        focus_reason: chosen.focus_reason
      },
      message: `已自动聚焦到：${chosen.title}`
    });
  } catch (error) {
    console.error('Error auto focusing:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
