/**
 * Drive Helper — 共享的「手动驱动任务」工具函数
 * 供 agent-worker.js 和 server API 共用
 */

function buildDrivePrompt(task, opts = {}) {
  const step = task.heartbeat_step || '执行中';
  const progress = task.heartbeat_progress || 0;
  const blockers = Array.isArray(task.heartbeat_blockers)
    ? task.heartbeat_blockers
    : JSON.parse(task.heartbeat_blockers || '[]');
  const attempts = task.attempt_log || [];

  const isDataSyncTask = (task.description || '').includes('fetch_') ||
                          (task.description || '').includes('duckdb') ||
                          (task.description || '').includes('同步');

  let prompt = '';
  if (opts.isManual) {
    prompt += `【紧急执行】你是 TODO Server 的执行引擎，必须立即执行任务。\n\n`;
  } else {
    prompt += `【自动执行模式】你是 TODO Server 的执行引擎，必须主动推进任务执行。\n\n`;
  }

  prompt += `## 任务信息\n`;
  prompt += `- 任务名称: ${task.title}\n`;
  prompt += `- 当前进度: ${progress}%\n`;
  prompt += `- 当前步骤: ${step}\n`;
  prompt += `- 尝试次数: ${task.attempt_count || 0}/${task.max_attempts || 3}\n`;

  if (blockers.length > 0) {
    prompt += `- 阻塞项: ${blockers.join(', ')}\n`;
  }

  const attemptsArray = Array.isArray(attempts) ? attempts : [];
  if (attemptsArray.length > 0) {
    prompt += `\n## 历史尝试记录\n`;
    attemptsArray.slice(-3).forEach((a, i) => {
      prompt += `${i + 1}. [${a.success ? '成功' : '失败'}] ${a.reason || ''}\n`;
    });
  }

  if (isDataSyncTask) {
    prompt += `\n## ⚡ 数据同步任务执行指令\n`;
    prompt += `这是数据同步任务，任务描述中的 \`fetch_*.py\` 脚本必须立即执行。\n`;
    prompt += `执行步骤：\n`;
    prompt += `1. 从任务描述中提取脚本路径和参数\n`;
    prompt += `2. 立即在 bash 块中执行脚本\n`;
    prompt += `3. 验证执行结果\n`;
    prompt += `4. 更新任务进度\n\n`;
  }

  prompt += `## 执行要求\n`;
  if (opts.isManual) {
    prompt += `1. 【强制】立即执行任务，不要等待用户确认\n`;
    prompt += `2. 如果任务描述包含脚本命令，立即执行\n`;
    prompt += `3. 汇报执行结果\n`;
  } else if (blockers.length > 0) {
    prompt += `1. 分析阻塞原因并尝试解决\n`;
    prompt += `2. 如果无法解决，使用 \`curl -X POST http://localhost:3000/api/agents/${task.agent_id}/todos/${task.id}/request-help\` 请求帮助\n`;
    prompt += `3. 继续推进任务\n`;
  } else {
    prompt += `1. 【强制】主动执行任务，不要等待用户输入\n`;
    prompt += `2. 如果任务描述包含具体执行步骤，按顺序执行\n`;
    prompt += `3. 汇报执行结果和进度更新\n`;
  }

  prompt += `\n## 回复格式\n`;
  prompt += `请直接执行命令并汇报结果，格式如下：\n\n`;
  prompt += `### 执行结果\n`;
  prompt += `- 命令: <执行的命令>\n`;
  prompt += `- 输出: <命令输出摘要>\n`;
  prompt += `- 进度: XX%\n\n`;
  prompt += `### 命令执行\n`;
  prompt += `\`\`\`bash\n`;
  prompt += `# 在此执行任务相关命令\n`;
  prompt += `\`\`\`\n`;

  if (task.acceptance_criteria) {
    prompt += `\n## 验收标准\n${task.acceptance_criteria}\n`;
  }

  if (task.description) {
    prompt += `\n## 任务描述\n${task.description}\n`;
  }

  prompt += `\n\n【重要】你是执行引擎，不是问答助手。不要回复"好的，我来执行"之类的话，直接执行命令！`;

  return prompt;
}

function parseHeartbeatReply(task, reply) {
  let newStep = task.heartbeat_step;
  let newProgress = task.heartbeat_progress;
  let newBlockers = Array.isArray(task.heartbeat_blockers)
    ? [...task.heartbeat_blockers]
    : JSON.parse(task.heartbeat_blockers || '[]');

  const progressMatch = reply.match(/进度[：:]\s*(\d+)%/);
  if (progressMatch) {
    newProgress = parseInt(progressMatch[1]);
  }

  const lines = reply.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 3 && firstLine.length < 100) {
      newStep = firstLine.replace(/^#+\s*/, '').substring(0, 80);
    }
  }

  if (reply.includes('完成') || reply.includes('成功') || reply.includes('✅')) {
    newProgress = Math.min(100, (newProgress || 0) + 10);
  }

  if (reply.includes('阻塞') || reply.includes('失败') || reply.includes('❌')) {
    const blockerMatch = reply.match(/阻塞[：:](.+?)(?:\n|$)/);
    if (blockerMatch && !newBlockers.includes(blockerMatch[1].trim())) {
      newBlockers.push(blockerMatch[1].trim());
    }
  }

  const oldBlockers = Array.isArray(task.heartbeat_blockers)
    ? task.heartbeat_blockers
    : JSON.parse(task.heartbeat_blockers || '[]');

  const changed = newStep !== task.heartbeat_step ||
                  newProgress !== task.heartbeat_progress ||
                  JSON.stringify(newBlockers) !== JSON.stringify(oldBlockers);

  return { progress: newProgress, step: newStep, blockers: newBlockers, changed };
}

module.exports = { buildDrivePrompt, parseHeartbeatReply };