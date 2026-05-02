const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const FocusState = require('../models/FocusState');

class ValidationDispatchService {
  constructor() {
    this.validatorAgentId = process.env.VALIDATOR_AGENT_ID || 'hermes-ops';
  }

  async dispatchValidationTask(executorAgentId, task, originalExecutionLogs) {
    const taskId = task.id;
    const taskTitle = task.title;

    // 检查是否已经存在相同的验证任务（防止重复创建）
    const existingValidationTask = Todo.findByTitle(this.validatorAgentId, `[验证] ${taskTitle}`);
    if (existingValidationTask && existingValidationTask.status === 'pending') {
      console.log(`[ValidationDispatch] 验证任务已存在，跳过创建: ${existingValidationTask.id}`);
      return existingValidationTask;
    }

    const validationTaskTitle = `[验证] ${taskTitle}`;
    const validationTaskDescription = `## 验证任务

这是一个由系统自动派发的独立验证任务。

### 原始任务信息
- **任务 ID**: ${taskId}
- **执行 Agent**: ${executorAgentId}
- **任务标题**: ${taskTitle}
- **任务描述**: ${task.description || '无'}

### 验收标准
${task.acceptance_criteria || '未设置明确验收标准'}

### 执行日志摘要
${originalExecutionLogs.slice(0, 3000)}

### 你的验证职责
1. **独立调查**：不要依赖执行 Agent 的说法，自己验证任务是否真正完成
2. **实际检查**：如果涉及数据/文件/系统状态，请实际执行命令验证
3. **客观评分**：根据实际情况给出 0-100 的评分

### 验证完成后
请调用以下 API 提交验证报告：
\`\`\`
POST http://localhost:3000/api/agents/${executorAgentId}/todos/${taskId}/validation-report
Headers:
  X-Agent-Secret: <你的 Agent Secret Key>
  Content-Type: application/json
Body:
{
  "validatorAgentId": "<你的 Agent ID>",
  "pass": true/false,
  "reason": "通过/失败原因",
  "feedback": "详细反馈和建议",
  "score": 0-100
}
\`\`\`
`;

    const validationTask = Todo.create(this.validatorAgentId, {
      title: validationTaskTitle,
      description: validationTaskDescription,
      priority: task.priority || 'medium',
      tags: ['auto-validation', 'third-party', `ref-${taskId.slice(0, 8)}`],
      context: JSON.stringify({
        type: 'third_party_validation',
        originalTaskId: taskId,
        executorAgentId: executorAgentId,
        dispatchedAt: new Date().toISOString()
      }),
      assigned_agent_id: this.validatorAgentId  // 添加指派
    });

    // 自动聚焦到验证任务
    await FocusState.setFocus(this.validatorAgentId, validationTask.id);

    Context.create(this.validatorAgentId, {
      sessionId: 'validation-dispatch',
      role: 'system',
      content: `[ValidationDispatch] 已创建第三方验证任务: ${validationTaskTitle}，原始任务: ${taskId}`,
      metadata: { type: 'validation_dispatch', task_id: taskId, validation_task_id: validationTask.id }
    });

    Notification.create(this.validatorAgentId, validationTask.id, 'assigned',
      `📋 新验证任务：${taskTitle}`
    );

    console.log(`[ValidationDispatch] 已派发验证任务: ${validationTask.id} -> ${this.validatorAgentId}，原始任务: ${taskId}`);
    return validationTask;
  }
}

module.exports = ValidationDispatchService;