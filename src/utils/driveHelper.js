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

  let prompt = '';
  if (opts.isManual) {
    prompt += `【用户手动触发】你是 TODO Server 的智能体工作进程，当前收到用户的立即执行指令。\n\n`;
  } else {
    prompt += `你是 TODO Server 的智能体工作进程，当前正在执行任务。\n\n`;
  }

  prompt += `## 任务信息\n`;
  prompt += `- 任务名称: ${task.title}\n`;
  prompt += `- 当前进度: ${progress}%\n`;
  prompt += `- 当前步骤: ${step}\n`;
  prompt += `- 尝试次数: ${task.attempt_count || 0}/${task.max_attempts || 3}\n`;

  if (blockers.length > 0) {
    prompt += `- 阻塞项: ${blockers.join(', ')}\n`;
  }

  if (attempts.length > 0) {
    prompt += `\n## 历史尝试记录\n`;
    attempts.slice(-3).forEach((a, i) => {
      prompt += `${i + 1}. [${a.success ? '成功' : '失败'}] ${a.reason || ''}\n`;
    });
  }

  prompt += `\n## 请执行以下操作\n`;
  if (opts.isManual) {
    prompt += `1. 立即汇报当前状态（具体完成了什么、卡在哪里）\n`;
    prompt += `2. 继续推进任务，不要等待\n`;
    prompt += `3. 更新进度信息\n`;
  } else if (blockers.length > 0) {
    prompt += `1. 分析当前阻塞原因\n`;
    prompt += `2. 提出解决方案或需要的外部支持\n`;
    prompt += `3. 如果可能，继续推进任务\n`;
  } else {
    prompt += `1. 汇报当前进展（具体完成了什么）\n`;
    prompt += `2. 继续执行下一步工作\n`;
    prompt += `3. 更新进度信息\n`;
  }

  prompt += `\n## 回复格式要求\n`;
  prompt += `请在回复中包含：\n`;
  prompt += `- 当前完成的具体工作\n`;
  prompt += `- 进度: XX%（更新后的进度）\n`;
  prompt += `- 下一步计划\n`;
  prompt += `- 如有阻塞请明确说明\n`;

  if (task.acceptance_criteria) {
    prompt += `\n## 验收标准\n${task.acceptance_criteria}`;
  }

  prompt += `\n\n现在请开始工作。`;
  return prompt;
}

function parseHeartbeatReply(task, reply) {
  let newStep = task.heartbeat_step;
  let newProgress = task.heartbeat_progress;
  let newBlockers = Array.isArray(task.heartbeat_blockers)
    ? [...task.heartbeat_blockers]
    : JSON.parse(task.heartbeat_blockers || '[]');

  // 从回复中提取进度信息
  const progressMatch = reply.match(/进度[：:]\s*(\d+)%/);
  if (progressMatch) {
    newProgress = parseInt(progressMatch[1]);
  }

  // 从回复中提取步骤信息（找第一行非空内容作为步骤）
  const lines = reply.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 3 && firstLine.length < 100) {
      newStep = firstLine.replace(/^#+\s*/, '').substring(0, 80);
    }
  }

  // 如果回复中包含"完成"或"成功"，提高进度
  if (reply.includes('完成') || reply.includes('成功') || reply.includes('✅')) {
    newProgress = Math.min(100, (newProgress || 0) + 10);
  }

  // 如果回复中包含"阻塞"或"失败"，添加阻塞项
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
