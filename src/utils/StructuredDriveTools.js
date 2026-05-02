/**
 * StructuredDriveTools — 结构化工具调用系统
 *
 * 解决 ProgressValidator 正则解析的脆弱性问题：
 * - LLM 必须通过工具调用报告 progress / step / blockers / completion
 * - 不再依赖自由文字回复的格式约定
 * - 工具调用结果直接写入 DB，无需解析
 *
 * 工具列表：
 *   updateProgress({ progress, step, blockers? })
 *   confirmCompletion({ summary, criteriaMet, evidence })
 *   askForHelp({ blocker, neededResource, alternativesTried })
 */

const Todo = require('../models/Todo');
const Context = require('../models/Context');

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "updateProgress",
      description: "更新当前任务的进度信息。每次工作循环都应该调用此工具报告状态。",
      parameters: {
        type: "object",
        properties: {
          progress: {
            type: "integer",
            description: "进度百分比 0-100",
            minimum: 0,
            maximum: 100
          },
          step: {
            type: "string",
            description: "当前具体步骤，一句话描述正在做什么"
          },
          blockers: {
            type: "array",
            items: { type: "string" },
            description: "当前遇到的阻塞项列表（可选，填写则替换当前 blockers）"
          },
          resolvedBlockers: {
            type: "array",
            items: { type: "string" },
            description: "已解决的阻塞项，调用后将从任务 blockers 中移除"
          }
        },
        required: ["progress", "step"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "confirmCompletion",
      description: "任务已完成，标记为 completed。只有当验收标准全部满足时才调用。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "完成摘要，简述完成了什么"
          },
          criteriaMet: {
            type: "array",
            items: { type: "string" },
            description: "已满足的验收标准条目"
          },
          evidence: {
            type: "string",
            description: "验收证据，说明如何验证每条标准"
          }
        },
        required: ["summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "askForHelp",
      description: "遇到无法自行解决的阻塞时调用，请求人工介入或外部支持。",
      parameters: {
        type: "object",
        properties: {
          blocker: {
            type: "string",
            description: "阻塞的具体描述"
          },
          neededResource: {
            type: "string",
            description: "需要什么资源或支持"
          },
          alternativesTried: {
            type: "array",
            items: { type: "string" },
            description: "已经尝试过的替代方案"
          }
        },
        required: ["blocker", "neededResource"]
      }
    }
  }
];

const TOOL_NAMES = ['updateProgress', 'confirmCompletion', 'askForHelp'];

function buildStructuredDrivePrompt(task, opts = {}) {
  const blockers = Array.isArray(task.heartbeat_blockers)
    ? task.heartbeat_blockers
    : JSON.parse(task.heartbeat_blockers || '[]');

  const lines = [];

  if (opts.isManual) {
    lines.push(`【用户手动触发】你是 TODO Server 的智能体工作进程，当前收到用户的立即执行指令。\n`);
  } else {
    lines.push(`你是 TODO Server 的智能体工作进程，当前正在执行任务。\n`);
  }

  lines.push(`## 任务信息`);
  lines.push(`- 任务名称: ${task.title}`);
  lines.push(`- 当前进度: ${task.heartbeat_progress || 0}%`);
  lines.push(`- 当前步骤: ${task.heartbeat_step || '执行中'}`);
  lines.push(`- 尝试次数: ${task.attempt_count || 0}/${task.max_attempts || 3}`);

  if (blockers.length > 0) {
    lines.push(`- 阻塞项: ${blockers.join(', ')}`);
  }

  lines.push(`\n## 验收标准`);
  if (task.acceptance_criteria) {
    lines.push(task.acceptance_criteria);
  } else {
    lines.push(`（未设置验收标准，任务完成以实际产出为准）`);
  }

  lines.push(`\n## 你的工作流程（严格遵守）`);
  lines.push(`1. 分析当前状态，决定是否继续执行还是求助`);
  lines.push(`2. 【必须】调用 updateProgress 报告当前进度（progress: 0-100, step: 一句话）`);
  lines.push(`3. 如果阻塞无法自行解决，调用 askForHelp`);
  lines.push(`4. 任务全部完成后，【必须】调用 confirmCompletion 并列出 criteriaMet`);

  lines.push(`\n## 工具调用说明`);
  lines.push(`- updateProgress：每次工作循环至少调用一次`);
  lines.push(`- confirmCompletion：仅在任务完成时调用，调用后任务自动标记为 completed`);
  lines.push(`- askForHelp：阻塞超过 2 分钟无法自行解决时调用`);
  lines.push(`- 所有工具调用都会被执行，结果直接写入任务记录`);
  lines.push(`- 不要在回复文字中描述进度，统一通过工具调用更新`);

  lines.push(`\n现在请开始工作。`);

  return lines.join('\n');
}

async function executeToolCall(toolCall, agentId, taskId, sessionId) {
  const { name, arguments: rawArgs } = toolCall.function || toolCall;
  const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

  if (!TOOL_NAMES.includes(name)) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  const task = Todo.findById(agentId, taskId);
  if (!task) {
    return { success: false, error: `Task ${taskId} not found` };
  }

  let note = '';

  if (name === 'updateProgress') {
    const { progress, step, blockers, resolvedBlockers: explicitResolved } = args;

    const currentBlockers = blockers
      ? blockers
      : [...(Array.isArray(task.heartbeat_blockers) ? task.heartbeat_blockers : [])];

    const prevProgress = task.heartbeat_progress || 0;
    const toResolve = explicitResolved || [];
    if (toResolve.length > 0) {
      toResolve.forEach(rb => {
        const idx = currentBlockers.indexOf(rb);
        if (idx !== -1) currentBlockers.splice(idx, 1);
      });
      note = `已解决阻塞: ${toResolve.join(', ')}`;
    } else if (progress > prevProgress && currentBlockers.length > 0) {
      const autoResolved = currentBlockers.filter(b =>
        !b.includes('网络') && !b.includes('权限') && !b.includes('人工')
      );
      if (autoResolved.length > 0) {
        autoResolved.forEach(b => {
          const idx = currentBlockers.indexOf(b);
          if (idx !== -1) currentBlockers.splice(idx, 1);
        });
        note = `自动清理已解决阻塞: ${autoResolved.join(', ')}（progress 提升 ${prevProgress}% → ${progress}%）`;
      }
    }

    Todo.updateHeartbeat(agentId, taskId, {
      progress: Math.max(0, Math.min(100, progress)),
      step: (step || '').substring(0, 200),
      blockers: currentBlockers
    });

    return {
      success: true,
      action: 'progress_updated',
      progress,
      step,
      note
    };
  }

  if (name === 'confirmCompletion') {
    const { summary, criteriaMet, evidence } = args;

    Todo.update(agentId, taskId, {
      status: 'completed',
      criteriaConfirmed: true,
      description: task.description
        ? `${task.description}\n\n## 完成摘要\n${summary}\n\n## 验收证据\n${evidence || ''}`
        : `\n## 完成摘要\n${summary}\n\n## 验收证据\n${evidence || ''}`,
      heartbeatProgress: 100,
      heartbeatStep: '✅ 已完成'
    });

    if (criteriaMet && criteriaMet.length > 0) {
      Todo.update(agentId, taskId, {
        context: `验收标准满足情况：\n${criteriaMet.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      });
    }

    Context.create(agentId, {
      sessionId: sessionId || 'structured-drive',
      role: 'system',
      content: `[confirmCompletion] 任务「${task.title}」已完成，criteriaMet=${JSON.stringify(criteriaMet || [])}`,
      metadata: { type: 'task_completion', task_id: taskId, criteria_met: criteriaMet || [] }
    });

    return {
      success: true,
      action: 'task_completed',
      summary,
      criteriaMet: criteriaMet || []
    };
  }

  if (name === 'askForHelp') {
    const { blocker, neededResource, alternativesTried } = args;

    const currentBlockers = Array.isArray(task.heartbeat_blockers)
      ? task.heartbeat_blockers
      : JSON.parse(task.heartbeat_blockers || '[]');

    if (!currentBlockers.includes(blocker)) {
      currentBlockers.push(blocker);
    }

    Todo.updateHeartbeat(agentId, taskId, {
      progress: task.heartbeat_progress || 0,
      step: `🔴 等待支援：${blocker}`,
      blockers: currentBlockers
    });

    Todo.update(agentId, taskId, { status: 'blocked' });

    const { Notification } = require('../models/Notification');
    Notification.create(agentId, taskId, 'blocked',
      `🔴 任务「${task.title}」请求支援：${blocker}，需要：${neededResource}，已试过：${(alternativesTried || []).join(', ')}`
    );

    return {
      success: true,
      action: 'help_requested',
      blocker,
      neededResource
    };
  }

  return { success: false, error: 'Tool not implemented' };
}

async function extractAndExecuteToolCalls(reply, agentId, taskId, sessionId) {
  const toolCalls = [];

  const jsonMatch = reply.match(/"tool_calls"\s*:\s*\[([\s\S]*?)\]\s*}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(`{${jsonMatch[0]}}`);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if ((tc.function || {}).name) {
            toolCalls.push(tc);
          }
        }
      }
    } catch (e) {}
  }

  if (toolCalls.length === 0) {
    const functionMatches = reply.matchAll(/<function_calls>([\s\S]*?)<\/function_calls>/g);
    for (const match of functionMatches) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed)) {
          for (const tc of parsed) {
            if ((tc.function || {}).name) toolCalls.push(tc);
          }
        }
      } catch (e) {}
    }
  }

  const results = [];
  for (const toolCall of toolCalls) {
    const result = await executeToolCall(toolCall, agentId, taskId, sessionId);
    results.push({ toolCall, result });
  }

  return results;
}

module.exports = {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  buildStructuredDrivePrompt,
  executeToolCall,
  extractAndExecuteToolCalls
};
