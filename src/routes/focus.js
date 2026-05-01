const express = require('express');
const Agent = require('../models/Agent');
const Todo = require('../models/Todo');
const FocusState = require('../models/FocusState');
const Context = require('../models/Context');
const { getDb } = require('../db');

const router = express.Router({ mergeParams: true });

router.use((req, res, next) => {
  const { agentId } = req.params;
  if (!Agent.exists(agentId)) {
    return res.status(404).json({ error: 'Not found', message: 'Agent not found' });
  }
  next();
});

// GET /api/agents/:agentId/focus — 获取当前聚焦状态 + 任务详情
router.get('/', async (req, res) => {
  try {
    const { agentId } = req.params;
    const driveFramework = req.app.get('driveFramework');
    const llmManager = driveFramework && driveFramework.modules
      ? driveFramework.modules.llmManager
      : null;
    const context = await FocusState.getFocusContext(agentId, llmManager);

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

    const workAnalysis = await buildWorkAnalysis(agentId, task, driveFramework);

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
router.post('/auto', async (req, res) => {
  try {
    const { agentId } = req.params;
    const fw = req.app.get('driveFramework');
    const lm = fw && fw.modules ? fw.modules.llmManager : null;
    const chosen = await FocusState.autoFocus(agentId, lm);

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

const LLMPrompts = {
  workAnalysis: (task, activityLines, attemptLines, idleMinutes) =>
    `你是一个 TODO Server 任务状态分析助手。请根据以下信息，推断智能体当前的真实工作状态。

## 当前任务
- 标题: ${task.title}
- 进度: ${task.heartbeat_progress || 0}%
- 最后心跳步骤: ${task.heartbeat_step || '无'}
- 阻塞项: ${(task.heartbeat_blockers || []).length > 0 ? (task.heartbeat_blockers || []).join('、') : '无'}
- 距离上次心跳: ${idleMinutes} 分钟
- 尝试次数: ${task.attempt_count || 0}/${task.max_attempts || 3}

## 最近活动记录
${activityLines || '无'}

## 执行记录
${attemptLines || '无执行记录'}

## 请判断
1. 智能体是否仍在有效工作？（true / false / uncertain）
2. 如果仍在工作，当前可能在做什么？（一句话描述）
3. 如果未工作，最可能的原因是什么？（等待输入 / 遇到错误 / 已完成 / 失联 / 其他）
4. 建议的任务状态：（in_progress / blocked / completed）
5. 置信度（0-1 之间的小数）

请只返回纯 JSON，不要有任何其他文字：
{"is_working": true, "current_action": "...", "reason": "...", "suggested_status": "in_progress", "confidence": 0.85}`,

  focusScore: (candidates) => {
    const candidateList = candidates.map((t, i) =>
      `${i + 1}. [${t.priority}] ${t.title}${t.description ? ' — ' + t.description.substring(0, 80) : ''}${t.context ? ' (上下文: ' + t.context.substring(0, 60) + ')' : ''}`
    ).join('\n');
    return `你是任务调度助手。请从以下候选任务中选择当前最应该执行的一个。

选择标准：
1. 紧急程度 — 用户最关心哪个？优先级高的优先
2. 完成难度 — 哪个能快速产出结果？简单任务优先（快速交付）
3. 依赖关系 — 哪个能解锁后续更多任务？
4. 风险评估 — 哪个失败代价最大？

候选任务列表：
${candidateList}

请只返回纯 JSON，不要包含其他文字：
{"chosen_index": 0, "reason": "选择原因", "estimated_minutes": 30}`;
  }
};

function _collectActivityLines(agentId) {
  try {
    const recentContexts = Context.findRecentByAgent(agentId, 15);
    return recentContexts.map(c => {
      const meta = typeof c.metadata === 'string' ? JSON.parse(c.metadata || '{}') : c.metadata;
      return `[${c.created_at}] ${meta.type || 'activity'}: ${c.content.substring(0, 120)}`;
    }).join('\n');
  } catch (e) {
    return '';
  }
}

function _collectAttemptLines(task) {
  return (task.attempt_log || []).slice(-5).map((a, i) =>
    `${i + 1}. [${a.success ? '成功' : '失败'}] ${a.reason || ''} — ${a.output || ''}`
  ).join('\n') || '无执行记录';
}

async function _tryLLMWorkAnalysis(agentId, task, driveFramework) {
  if (!driveFramework || !driveFramework.initialized) return null;
  if (!driveFramework.modules.llmManager || !driveFramework.modules.llmManager.hasProvider()) return null;

  const now = Date.now();
  const lastHeartbeat = task.last_heartbeat ? parseDbTime(task.last_heartbeat) : 0;
  const idleMinutes = lastHeartbeat ? Math.floor((now - lastHeartbeat) / 60000) : 999;

  const activityLines = _collectActivityLines(agentId);
  const attemptLines = _collectAttemptLines(task);

  const prompt = LLMPrompts.workAnalysis(task, activityLines, attemptLines, idleMinutes);

  const result = await driveFramework.modules.llmManager.chat({
    messages: [{ role: 'user', content: prompt }],
    system: '你是一个任务状态分析助手，请基于活动记录推断智能体状态，只返回 JSON。'
  });

  const reply = result.content || '';
  const jsonMatch = reply.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const inference = JSON.parse(jsonMatch[0]);
    if (typeof inference.confidence !== 'number') return null;
    return { inference, idleMinutes };
  } catch (e) {
    return null;
  }
}

function _inferenceToWorkAnalysis(inference, task, contextActivity) {
  const { inference: inf, idleMinutes } = inference;
  const confidence = inf.confidence;
  const isWorking = inf.is_working;
  const suggestedStatus = inf.suggested_status;

  let status, statusLabel, statusColor, currentAction;

  if (suggestedStatus === 'completed' && !isWorking) {
    status = 'completed';
    statusLabel = '已完成';
    statusColor = 'green';
    currentAction = inf.reason || '任务已完成';
  } else if (suggestedStatus === 'blocked' && !isWorking) {
    status = 'blocked';
    statusLabel = '已阻塞';
    statusColor = 'red';
    currentAction = inf.reason ? `被阻塞：${inf.reason}` : '任务被卡住';
  } else if (isWorking) {
    status = 'active';
    statusLabel = '活跃工作中';
    statusColor = 'green';
    currentAction = inf.current_action || inf.reason || '正在执行';
  } else if (suggestedStatus === 'blocked') {
    status = 'stuck';
    statusLabel = '可能卡住';
    statusColor = 'orange';
    currentAction = inf.reason || '长时间无响应';
  } else {
    status = 'idle';
    statusLabel = '空闲/等待中';
    statusColor = 'blue';
    currentAction = inf.reason || '等待调度';
  }

  const blockers = task.heartbeat_blockers || [];
  const attempts = task.attempt_log || [];

  return {
    status,
    status_label: statusLabel,
    status_color: statusColor,
    idle_minutes: idleMinutes,
    last_heartbeat: task.last_heartbeat,
    current_step: task.heartbeat_step || '无步骤信息',
    current_action: currentAction,
    progress: task.heartbeat_progress || 0,
    blockers,
    blocker_count: blockers.length,
    attempt_count: task.attempt_count || 0,
    max_attempts: task.max_attempts || 3,
    attempts_remaining: (task.max_attempts || 3) - (task.attempt_count || 0),
    recent_attempts: attempts.slice(-3),
    health_score: Math.max(0, 100 - idleMinutes * 2 - blockers.length * 15 - (task.attempt_count || 0) * 10),
    context_activity: contextActivity,
    llm_analysis: { confidence, reason: inf.reason, is_working: isWorking }
  };
}

function _ruleBasedWorkAnalysis(agentId, task) {
  const now = Date.now();
  const lastHeartbeat = task.last_heartbeat ? parseDbTime(task.last_heartbeat) : 0;
  const idleMinutes = lastHeartbeat ? Math.floor((now - lastHeartbeat) / 60000) : 999;
  const blockers = task.heartbeat_blockers || [];
  const attempts = task.attempt_log || [];

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
  } catch (e) {}

  const hasRecentContext = contextActivity && contextActivity.age_minutes < 15;
  const hasVeryRecentContext = contextActivity && contextActivity.age_minutes < 5;

  let status = 'unknown';
  let statusLabel = '未知';
  let statusColor = 'gray';

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

  let currentAction = '';
  if (status === 'active') {
    if (hasRecentContext) {
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
    blockers,
    blocker_count: blockers.length,
    attempt_count: task.attempt_count || 0,
    max_attempts: task.max_attempts || 3,
    attempts_remaining: (task.max_attempts || 3) - (task.attempt_count || 0),
    recent_attempts: attempts.slice(-3),
    health_score: Math.max(0, 100 - idleMinutes * 2 - blockers.length * 15 - (task.attempt_count || 0) * 10),
    context_activity: contextActivity
  };
}

async function buildWorkAnalysis(agentId, task, driveFramework) {
  const now = Date.now();
  const lastHeartbeat = task.last_heartbeat ? parseDbTime(task.last_heartbeat) : 0;
  const idleMinutes = lastHeartbeat ? Math.floor((now - lastHeartbeat) / 60000) : 999;

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
  } catch (e) {}

  const db = getDb();
  const recentInference = db.prepare(`
    SELECT metadata, created_at FROM contexts
    WHERE agent_id = ? AND session_id = 'llm-inference'
      AND metadata LIKE ?
    ORDER BY created_at DESC LIMIT 1
  `).get(agentId, `%"task_id":"${task.id}"%`);

  if (recentInference) {
    const createdAt = parseDbTime(recentInference.created_at);
    const ageMinutes = (now - createdAt) / 60000;
    if (ageMinutes < 5) {
      try {
        const meta = typeof recentInference.metadata === 'string'
          ? JSON.parse(recentInference.metadata)
          : recentInference.metadata;
        if (meta && meta.inference) {
          const storedIdleMin = meta.idle_minutes || idleMinutes;
          return _inferenceToWorkAnalysis(
            { inference: meta.inference, idleMinutes: storedIdleMin },
            task, contextActivity
          );
        }
      } catch (e) {}
    }
  }

  try {
    const llmResult = await _tryLLMWorkAnalysis(agentId, task, driveFramework);
    if (llmResult) {
      try {
        db.prepare(`
          INSERT INTO contexts (id, agent_id, session_id, role, content, metadata, created_at)
          VALUES (?, ?, 'llm-inference', 'system', ?, ?, datetime('now'))
        `).run(
          require('uuid').v4(), agentId,
          `[LLM推断-API] 任务「${task.title}」idle ${idleMinutes}min`,
          JSON.stringify({
            type: 'llm_inference',
            task_id: task.id,
            inference: llmResult.inference,
            idle_minutes: idleMinutes
          })
        );
      } catch (e) {}

      return _inferenceToWorkAnalysis(llmResult, task, contextActivity);
    }
  } catch (e) {
    console.error(`[buildWorkAnalysis] LLM 推断失败，回退到规则引擎: ${e.message}`);
  }

  return _ruleBasedWorkAnalysis(agentId, task);
}

module.exports = router;
