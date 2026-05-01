const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');

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
      // Fix: 即使没有聚焦任务，如果检测到近期活动，返回合成 work_analysis
      const syntheticAnalysis = buildSyntheticWorkAnalysis(agentId);
      if (syntheticAnalysis) {
        return res.json({
          success: true,
          data: {
            focus_state: null,
            current_task: null,
            parent_task: null,
            subtasks: [],
            siblings: [],
            focus_message: '当前没有聚焦的任务，但检测到智能体近期活动',
            recent_contexts: Context.findRecentByAgent(agentId, 10),
            attempt_history: [],
            work_analysis: syntheticAnalysis
          },
          message: '当前没有聚焦的任务，但检测到智能体近期活动'
        });
      }
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
      message += `\n进度：${Math.round(task.heartbeat_progress)}%\n`;
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

    // 获取最近的对话上下文（最近 10 条）
    const recentContexts = Context.findRecentByAgent(agentId, 10);

    // 构建工作状态分析（结合任务心跳 + 最近活动记录）
    const workAnalysis = buildWorkAnalysis(agentId, task);

    res.json({
      success: true,
      data: {
        focus_state: context.focus_state,
        current_task: task,
        parent_task: parent,
        subtasks: subtasks,
        siblings: context.siblings,
        focus_message: message,
        recent_contexts: recentContexts,
        attempt_history: task.attempt_log || [],
        work_analysis: workAnalysis
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

// 当没有聚焦任务时，基于 contexts 构建合成工作状态分析
function buildSyntheticWorkAnalysis(agentId) {
  try {
    const recentContexts = Context.findRecentByAgent(agentId, 20);
    const nonSnapshot = recentContexts.filter(c =>
      c.session_id !== 'work-snapshot' &&
      c.session_id !== 'llm-inference'
    );
    if (nonSnapshot.length === 0) return null;

    const latest = nonSnapshot[nonSnapshot.length - 1];
    const now = Date.now();
    const ageMin = Math.floor((now - parseDbTime(latest.created_at)) / 60000);
    if (ageMin > 30) return null; // 超过 30 分钟不认为活跃

    const meta = typeof latest.metadata === 'string' ? JSON.parse(latest.metadata || '{}') : latest.metadata;
    const isVeryRecent = ageMin < 5;

    return {
      status: isVeryRecent ? 'active' : 'idle',
      status_label: isVeryRecent ? '活跃工作中（无聚焦任务）' : '近期有活动但空闲',
      status_color: isVeryRecent ? 'green' : 'blue',
      idle_minutes: ageMin,
      last_heartbeat: null,
      current_step: '无聚焦任务',
      current_action: `[${meta.type || 'activity'}] ${latest.content.substring(0, 120)}`,
      progress: 0,
      blockers: [],
      blocker_count: 0,
      attempt_count: 0,
      max_attempts: 3,
      attempts_remaining: 3,
      recent_attempts: [],
      health_score: Math.max(0, 100 - ageMin * 2),
      context_activity: {
        age_minutes: ageMin,
        type: meta.type || 'activity',
        content: latest.content.substring(0, 120),
        created_at: latest.created_at
      }
    };
  } catch (e) {
    return null;
  }
}

// SQLite DATETIME 返回 YYYY-MM-DD HH:MM:SS（实际 UTC），需要按 UTC 解析
function parseDbTime(dateStr) {
  if (!dateStr) return 0;
  const utcStr = dateStr.replace(' ', 'T') + 'Z';
  return new Date(utcStr).getTime();
}

// 构建智能体工作状态分析（结合任务心跳 + 最近活动记录）
function buildWorkAnalysis(agentId, task) {
  const now = Date.now();
  const lastHeartbeat = task.last_heartbeat ? parseDbTime(task.last_heartbeat) : 0;
  const idleMinutes = lastHeartbeat ? Math.floor((now - lastHeartbeat) / 60000) : 999;
  const blockers = task.heartbeat_blockers || [];
  const attempts = task.attempt_log || [];

  // Fix 2: 从 contexts 表推断最近活动（即使任务心跳过时）
  let contextActivity = null;
  try {
    const recentContexts = Context.findRecentByAgent(agentId, 20);
    const nonSnapshot = recentContexts.filter(c =>
      c.session_id !== 'work-snapshot' &&
      c.session_id !== 'llm-inference'
    );
    if (nonSnapshot.length > 0) {
      const latest = nonSnapshot[nonSnapshot.length - 1];
      const contextAgeMin = Math.floor((now - parseDbTime(latest.created_at)) / 60000);
      const meta = typeof latest.metadata === 'string' ? JSON.parse(latest.metadata || '{}') : latest.metadata;
      contextActivity = {
        age_minutes: contextAgeMin,
        type: meta.type || 'activity',
        content: latest.content.substring(0, 120),
        created_at: latest.created_at
      };
    }
  } catch (e) {
    // 忽略 contexts 查询错误
  }

  // 如果 contexts 有最近活动（< 15 分钟），则认为智能体仍在工作
  const hasRecentContext = contextActivity && contextActivity.age_minutes < 15;
  const hasVeryRecentContext = contextActivity && contextActivity.age_minutes < 5;

  let status = 'unknown';
  let statusLabel = '未知';
  let statusColor = 'gray';

  // 最近 contexts 活动可以覆盖 blocked/completed 状态（智能体在做其他事）
  if (hasVeryRecentContext) {
    status = 'active';
    statusLabel = '活跃工作中';
    statusColor = 'green';
  } else if (task.status === 'blocked') {
    status = 'blocked';
    statusLabel = '已阻塞';
    statusColor = 'red';
  } else if (task.status === 'completed') {
    status = 'completed';
    statusLabel = '已完成';
    statusColor = 'green';
  } else if (idleMinutes > 15 && !hasRecentContext) {
    status = 'stuck';
    statusLabel = '可能卡住';
    statusColor = 'orange';
  } else if (blockers.length > 0) {
    status = 'blocked_with_recovery';
    statusLabel = '有阻塞但运行中';
    statusColor = 'yellow';
  } else if (idleMinutes <= 2 || hasRecentContext) {
    status = 'active';
    statusLabel = '活跃工作中';
    statusColor = 'green';
  } else {
    status = 'idle';
    statusLabel = '空闲/等待中';
    statusColor = 'blue';
  }

  // 当前具体动作描述
  let currentAction = '';
  if (status === 'active') {
    if (hasRecentContext) {
      // 优先使用最近 contexts 内容作为当前动作
      currentAction = `[${contextActivity.type}] ${contextActivity.content}`;
    } else {
      currentAction = task.heartbeat_step || '正在执行中';
    }
  } else if (status === 'blocked') {
    currentAction = blockers.length > 0
      ? `被阻塞：${blockers.join('、')}`
      : '任务被卡住，无法继续';
  } else if (status === 'blocked_with_recovery') {
    currentAction = `运行中但有阻塞：${blockers.join('、')}`;
  } else if (status === 'idle') {
    currentAction = '等待调度或指令';
  } else if (status === 'stuck') {
    currentAction = `长时间无响应（${idleMinutes}分钟），可能已经停止`;
  } else if (status === 'completed') {
    currentAction = '任务已完成';
  }

  return {
    status,
    status_label: statusLabel,
    status_color: statusColor,
    idle_minutes: idleMinutes,
    last_heartbeat: task.last_heartbeat,
    current_step: task.heartbeat_step || '无步骤信息',
    current_action: currentAction,
    progress: task.heartbeat_progress || 0,
    blockers: blockers,
    blocker_count: blockers.length,
    attempt_count: task.attempt_count || 0,
    max_attempts: task.max_attempts || 3,
    attempts_remaining: (task.max_attempts || 3) - (task.attempt_count || 0),
    recent_attempts: attempts.slice(-3),
    health_score: Math.max(0, 100 - idleMinutes * 2 - blockers.length * 15 - (task.attempt_count || 0) * 10),
    context_activity: contextActivity  // 新增：contexts 活动信息
  };
}

module.exports = router;
