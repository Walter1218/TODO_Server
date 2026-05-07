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
 *   proposeCompletion({ summary, criteriaMet, evidence })
 *   confirmCompletion({ summary, reason, criteriaMet?, evidence? })
 *   askForHelp({ blocker, neededResource, alternativesTried })
 */

const fs = require('fs');
const path = require('path');
const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const CompletionReportBuilder = require('../services/CompletionReportBuilder');
const CommandExecutor = require('../services/CommandExecutor');
const JobRunService = require('../services/JobRunService');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const HOME_DIR = process.env.HOME || PROJECT_ROOT;
const SAFE_READ_ROOTS = [PROJECT_ROOT, HOME_DIR, '/tmp'];
const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bmount\b/i,
  /\bumount\b/i
];

function buildToolResult(success, action, data = {}, error = null) {
  return {
    success,
    action,
    ...(success ? { data } : {}),
    ...(error ? { error } : {})
  };
}

function isPathAllowed(resolvedPath) {
  return SAFE_READ_ROOTS.some(root => resolvedPath === root || resolvedPath.startsWith(root + path.sep));
}

function resolveAllowedPath(filePath) {
  if (!filePath) {
    throw new Error('path is required');
  }

  const normalized = String(filePath).startsWith('~/')
    ? path.join(HOME_DIR, String(filePath).slice(2))
    : String(filePath);
  const resolved = path.resolve(normalized);
  if (!isPathAllowed(resolved)) {
    throw new Error(`Path outside allowed roots: ${resolved}`);
  }
  return resolved;
}

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "executeCommand",
      description: "执行一条 shell 命令并返回结果。用于推进任务、跑脚本、验证产出。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的命令"
          },
          cwd: {
            type: "string",
            description: "工作目录（可选）"
          },
          timeoutMs: {
            type: "integer",
            description: "超时时间，毫秒（可选）",
            minimum: 1000,
            maximum: 600000
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "readFile",
      description: "读取文件内容，用于查看配置、脚本、日志或输出文件。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件路径"
          },
          offset: {
            type: "integer",
            description: "起始行号（从 1 开始）",
            minimum: 1
          },
          limit: {
            type: "integer",
            description: "读取行数限制",
            minimum: 1,
            maximum: 200
          }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "checkPath",
      description: "检查文件或目录是否存在、大小、修改时间等元信息。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件或目录路径"
          }
        },
        required: ["path"]
      }
    }
  },
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
      name: "proposeCompletion",
      description: "任务已完成，提交验收申请，任务进入 pending_validation，由 TODO Server 内嵌校验智能体进行自动验收。",
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
          },
          completionDetails: {
            type: "object",
            description: "详细完成信息（可选，用于生成用户可见的完成报告）",
            properties: {
              dataLocation: { type: "string", description: "产出物位置（如数据文件路径、代码文件路径、报告链接等）" },
              timeCoverage: { type: "string", description: "数据时间覆盖范围（如 '2024-01-01 至 2024-04-30'）" },
              completionRate: { type: "string", description: "完成度（如 '100%' 或 '15/16 表完成'）" },
              missingData: { type: "string", description: "缺失数据说明（如 '2 个交易日数据延迟'）" },
              summary: { type: "string", description: "一句话概括完成结果" },
              artifacts: { type: "array", items: { type: "string" }, description: "产出物列表（文件路径、URL等）" }
            }
          }
        },
        required: ["summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "confirmCompletion",
      description: "强制完成（不推荐）。仅在你明确知道不需要自动验收，或自动验收不可用时使用。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "完成摘要，简述完成了什么"
          },
          reason: {
            type: "string",
            description: "为什么需要强制完成（例如：验收依赖人工系统、LLM 验收暂不可用等）"
          },
          criteriaMet: {
            type: "array",
            items: { type: "string" },
            description: "已满足的验收标准条目（可选）"
          },
          evidence: {
            type: "string",
            description: "验收证据（可选）"
          },
          completionDetails: {
            type: "object",
            description: "详细完成信息（可选）",
            properties: {
              dataLocation: { type: "string", description: "产出物位置" },
              timeCoverage: { type: "string", description: "数据时间覆盖范围" },
              completionRate: { type: "string", description: "完成度" },
              missingData: { type: "string", description: "缺失数据说明" },
              summary: { type: "string", description: "一句话概括" },
              artifacts: { type: "array", items: { type: "string" }, description: "产出物列表" }
            }
          }
        },
        required: ["summary", "reason"]
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

const TOOL_NAMES = ['executeCommand', 'readFile', 'checkPath', 'updateProgress', 'proposeCompletion', 'confirmCompletion', 'askForHelp'];

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
  lines.push(`1. 分析当前状态，优先使用工具推进任务`);
  lines.push(`2. 需要执行命令时调用 executeCommand`);
  lines.push(`3. 需要查看文件或路径时调用 readFile / checkPath`);
  lines.push(`4. 每轮有实质进展后都要调用 updateProgress`);
  lines.push(`5. 如果阻塞无法自行解决，调用 askForHelp`);
  lines.push(`6. 任务全部完成后，调用 proposeCompletion 并列出 criteriaMet`);

  lines.push(`\n## 工具调用说明`);
  lines.push(`- executeCommand：执行命令，结果会立刻返回给你用于下一轮判断`);
  lines.push(`- readFile：读取文件内容，用于查看脚本、配置、输出文件`);
  lines.push(`- checkPath：检查文件/目录状态，用于确认产出是否存在`);
  lines.push(`- updateProgress：每次工作循环至少调用一次`);
  lines.push(`- proposeCompletion：任务完成后提交验收申请，任务进入 pending_validation 并自动触发验收`);
  lines.push(`- confirmCompletion：强制完成（不推荐），仅在必须跳过自动验收时使用`);
  lines.push(`- askForHelp：阻塞超过 2 分钟无法自行解决时调用`);
  lines.push(`- 所有工具调用都会被执行，结果直接写入任务记录`);
  lines.push(`- 不要只输出自然语言计划；要通过工具真正推进任务`);
  lines.push(`- 不要在回复文字中描述进度，统一通过工具调用更新`);

  lines.push(`\n现在请开始工作。`);

  return lines.join('\n');
}

function mergeCompletionReport(autoReport, userDetails, userSummary, criteriaMet) {
  const report = { ...autoReport };
  if (userDetails) {
    if (!report.sections) report.sections = [];
    if (userDetails.dataLocation) {
      report.sections.push({ label: '产出位置', items: [userDetails.dataLocation] });
    }
    if (userDetails.timeCoverage) {
      report.sections.push({ label: '时间覆盖', items: [userDetails.timeCoverage] });
    }
    if (userDetails.completionRate) {
      report.sections.push({ label: '完成度', items: [userDetails.completionRate] });
    }
    if (userDetails.missingData) {
      report.sections.push({ label: '数据缺失', items: [userDetails.missingData] });
    }
    if (userDetails.artifacts && userDetails.artifacts.length > 0) {
      report.sections.push({ label: '产出物', items: userDetails.artifacts });
    }
  }
  if (userSummary) {
    report.userSummary = userSummary;
  }
  const detailEvidenceLines = [];
  if (userDetails?.dataLocation) detailEvidenceLines.push(`产出位置: ${userDetails.dataLocation}`);
  if (userDetails?.timeCoverage) detailEvidenceLines.push(`时间覆盖: ${userDetails.timeCoverage}`);
  if (userDetails?.completionRate) detailEvidenceLines.push(`完成度: ${userDetails.completionRate}`);
  if (userDetails?.missingData) detailEvidenceLines.push(`数据缺失: ${userDetails.missingData}`);
  report.validationEvidence = {
    criteriaMet: Array.isArray(criteriaMet) ? criteriaMet : [],
    artifacts: Array.isArray(userDetails?.artifacts) ? userDetails.artifacts : [],
    evidenceLines: detailEvidenceLines,
    summary: userSummary || report.summary || ''
  };
  report.generatedAt = new Date().toISOString();
  return report;
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

  if (name === 'executeCommand') {
    const { command, cwd, timeoutMs } = args;
    if (!command || !String(command).trim()) {
      return buildToolResult(false, 'command_rejected', {}, 'command is required');
    }

    if (DANGEROUS_COMMAND_PATTERNS.some(pattern => pattern.test(command))) {
      return buildToolResult(false, 'command_rejected', {}, 'command contains dangerous patterns');
    }

    const resolvedCwd = cwd ? resolveAllowedPath(cwd) : HOME_DIR;
    const results = await CommandExecutor.executeCommands(
      [{ index: 0, command: String(command).trim(), source: 'structured_tool' }],
      { cwd: resolvedCwd, timeoutMs: timeoutMs || 60000, maxCommands: 1 }
    );
    const result = results[0] || { success: false, output: 'No command result returned' };

    Context.create(agentId, {
      sessionId: sessionId || 'structured-drive',
      role: 'system',
      content: `[executeCommand] ${result.success ? '成功' : '失败'}: ${command}\n${String(result.output || '').slice(0, 500)}`,
      metadata: { type: 'structured_execute_command', task_id: taskId, command: String(command).slice(0, 200), success: !!result.success }
    });

    return buildToolResult(result.success, 'command_executed', {
      command,
      cwd: resolvedCwd,
      output: result.output || '',
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode,
      duration: result.duration,
      blockers: CommandExecutor.detectEnvironmentBlockers(result.output || '')
    }, result.success ? null : (result.output || 'command execution failed'));
  }

  if (name === 'readFile') {
    const { path: filePath, offset = 1, limit = 80 } = args;
    const resolved = resolveAllowedPath(filePath);
    if (!fs.existsSync(resolved)) {
      return buildToolResult(false, 'file_missing', { path: resolved }, 'file does not exist');
    }

    const content = fs.readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const take = Math.min(200, Math.max(1, Number(limit) || 80));
    const selected = lines.slice(start - 1, start - 1 + take);
    const rendered = selected.map((line, idx) => `${start + idx}→${line}`).join('\n');

    Context.create(agentId, {
      sessionId: sessionId || 'structured-drive',
      role: 'system',
      content: `[readFile] ${resolved} (${start}-${start + selected.length - 1})`,
      metadata: { type: 'structured_read_file', task_id: taskId, path: resolved }
    });

    return buildToolResult(true, 'file_read', {
      path: resolved,
      offset: start,
      limit: take,
      content: rendered
    });
  }

  if (name === 'checkPath') {
    const { path: filePath } = args;
    const resolved = resolveAllowedPath(filePath);
    const exists = fs.existsSync(resolved);
    if (!exists) {
      return buildToolResult(true, 'path_checked', {
        path: resolved,
        exists: false
      });
    }

    const stats = fs.statSync(resolved);
    Context.create(agentId, {
      sessionId: sessionId || 'structured-drive',
      role: 'system',
      content: `[checkPath] ${resolved} exists=${exists}`,
      metadata: { type: 'structured_check_path', task_id: taskId, path: resolved }
    });

    return buildToolResult(true, 'path_checked', {
      path: resolved,
      exists: true,
      isDirectory: stats.isDirectory(),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      createdAt: stats.birthtime.toISOString()
    });
  }

  if (name === 'updateProgress') {
    const { progress, step, blockers, resolvedBlockers: explicitResolved } = args;

    const currentBlockers = blockers
      ? blockers
      : [...(Array.isArray(task.heartbeat_blockers) ? task.heartbeat_blockers : [])];

    const prevProgress = task.heartbeat_progress || 0;
    const toResolve = explicitResolved || [];
    
    // 如果进度有明显提升（超过10%），自动清除所有阻塞项
    // 这可以解决 StuckTaskMonitor 误判导致的阻塞标记
    const progressDelta = progress - prevProgress;
    if (progressDelta > 10 && currentBlockers.length > 0) {
      const clearedBlockers = [...currentBlockers];
      currentBlockers.length = 0; // 清除所有阻塞项
      note = `进度提升 ${progressDelta}%，自动清除阻塞标记: ${clearedBlockers.join(', ')}`;
    } else if (toResolve.length > 0) {
      // 用户显式解决阻塞
      toResolve.forEach(rb => {
        const idx = currentBlockers.indexOf(rb);
        if (idx !== -1) currentBlockers.splice(idx, 1);
      });
      note = `已解决阻塞: ${toResolve.join(', ')}`;
    } else if (progress > prevProgress && currentBlockers.length > 0) {
      // 自动清理非严重阻塞项
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

    return buildToolResult(true, 'progress_updated', {
      progress,
      step,
      note
    });
  }

  if (name === 'proposeCompletion') {
    const { summary, criteriaMet, evidence, completionDetails } = args;

    const autoReport = CompletionReportBuilder.build(task, agentId);
    const finalReport = mergeCompletionReport(autoReport, completionDetails, summary, criteriaMet);

    const criteriaText = Array.isArray(criteriaMet) && criteriaMet.length > 0
      ? `验收标准满足情况：\n${criteriaMet.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    Todo.update(agentId, taskId, {
      status: 'pending_validation',
      criteriaConfirmed: true,
      description: task.description
        ? `${task.description}\n\n## 完成摘要\n${summary}\n\n## 验收证据\n${evidence || ''}`
        : `\n## 完成摘要\n${summary}\n\n## 验收证据\n${evidence || ''}`,
      heartbeatProgress: 100,
      heartbeatStep: '🧾 已提交验收申请（待自动校验）'
    });

    CompletionReportBuilder.storeReport(taskId, agentId, finalReport);
    JobRunService.markPendingValidation(agentId, Todo.findById(agentId, taskId), {
      source: 'structured_drive_propose_completion'
    });

    if (criteriaText) {
      Todo.update(agentId, taskId, { context: criteriaText });
    }

    Context.create(agentId, {
      sessionId: sessionId || 'completion-proposal',
      role: 'system',
      content: `[proposeCompletion] 任务「${task.title}」提交验收申请，criteriaMet=${JSON.stringify(criteriaMet || [])}`,
      metadata: { type: 'task_completion_proposal', task_id: taskId, criteria_met: criteriaMet || [], completion_report: finalReport }
    });

    return buildToolResult(true, 'task_pending_validation', {
      summary,
      completionReport: finalReport,
      criteriaMet: criteriaMet || []
    });
  }

  if (name === 'confirmCompletion') {
    const { summary, reason, criteriaMet, evidence, completionDetails } = args;

    const autoReport = CompletionReportBuilder.build(task, agentId);
    const finalReport = mergeCompletionReport(autoReport, completionDetails, summary, criteriaMet);

    const criteriaText = Array.isArray(criteriaMet) && criteriaMet.length > 0
      ? `验收标准满足情况：\n${criteriaMet.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';

    Todo.update(agentId, taskId, {
      status: 'completed',
      criteriaConfirmed: true,
      description: task.description
        ? `${task.description}\n\n## 完成摘要\n${summary}\n\n## 强制完成原因\n${reason || ''}\n\n## 验收证据\n${evidence || ''}`
        : `\n## 完成摘要\n${summary}\n\n## 强制完成原因\n${reason || ''}\n\n## 验收证据\n${evidence || ''}`,
      heartbeatProgress: 100,
      heartbeatStep: '✅ 已完成（强制完成）'
    });

    CompletionReportBuilder.storeReport(taskId, agentId, finalReport);
    JobRunService.markCompleted(agentId, Todo.findById(agentId, taskId), {
      source: 'structured_drive_confirm_completion'
    });

    if (criteriaText) {
      Todo.update(agentId, taskId, { context: criteriaText });
    }

    Context.create(agentId, {
      sessionId: sessionId || 'confirm-completion',
      role: 'system',
      content: `[confirmCompletion] 任务「${task.title}」被强制标记为完成，reason=${reason || ''}`,
      metadata: { type: 'task_force_completion', task_id: taskId, reason: reason || '', criteria_met: criteriaMet || [], completion_report: finalReport }
    });

    return buildToolResult(true, 'task_force_completed', {
      summary,
      completionReport: finalReport,
      reason: reason || '',
      criteriaMet: criteriaMet || []
    });
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
    JobRunService.markFailure(agentId, Todo.findById(agentId, taskId), 'human_blocked', {
      source: 'structured_drive_ask_for_help',
      blocker,
      neededResource
    });

    Notification.create(agentId, taskId, 'blocked',
      `🔴 任务「${task.title}」请求支援：${blocker}，需要：${neededResource}，已试过：${(alternativesTried || []).join(', ')}`
    );

    return buildToolResult(true, 'help_requested', {
      blocker,
      neededResource
    });
  }

  return buildToolResult(false, 'tool_not_implemented', {}, 'Tool not implemented');
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

async function executeToolCalls(toolCalls, agentId, taskId, sessionId) {
  const results = [];
  for (const toolCall of (toolCalls || [])) {
    const result = await executeToolCall(toolCall, agentId, taskId, sessionId);
    results.push({ toolCall, result });
  }
  return results;
}

const StructuredDriveTools = {
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  buildStructuredDrivePrompt,
  executeToolCall,
  executeToolCalls,
  extractAndExecuteToolCalls
};

module.exports = {
  ...StructuredDriveTools,
  StructuredDriveTools
};
