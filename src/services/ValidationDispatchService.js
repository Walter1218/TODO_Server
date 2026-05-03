const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Notification = require('../models/Notification');
const FocusState = require('../models/FocusState');

class ValidationDispatchService {
  constructor() {
    this.validatorAgentId = process.env.VALIDATOR_AGENT_ID || 'hermes-tester';
  }

  async dispatchValidationTask(executorAgentId, task, originalExecutionLogs) {
    const taskId = task.id;
    const taskTitle = task.title.replace(/^\[验证\]\s*/, ''); // 去掉已有的 [验证] 前缀
    
    // 检查原始任务是否本身就是验证任务，如果是，跳过
    if (task.title && task.title.startsWith('[验证]')) {
      console.log(`[ValidationDispatch] 原始任务已是验证任务，跳过: ${taskId} - ${taskTitle}`);
      return null;
    }
    
    // 检查 context 中是否已有 third_party_validation type
    try {
      const taskContext = JSON.parse(task.context || '{}');
      if (taskContext.type === 'third_party_validation') {
        console.log(`[ValidationDispatch] 原始任务 context.type 已是 third_party_validation，跳过: ${taskId}`);
        return null;
      }
    } catch (e) {
      // context 不是 JSON，忽略
    }

    // 检查是否已经存在相同的验证任务（防止重复创建）
    // 通过 context 中的 originalTaskId 来精确判断
    const db = require('../db').getDb();

    // 查询验证 agent 的 secret key
    const validatorAgent = db.prepare(`SELECT id, secret_key FROM agents WHERE id = ?`).get(this.validatorAgentId);
    if (!validatorAgent) {
      console.error(`[ValidationDispatch] 验证 agent ${this.validatorAgentId} 不存在`);
      return null;
    }

    // 方法1：使用 LIKE 查找所有验证任务，然后精确匹配 originalTaskId
    const potentialDuplicates = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND context LIKE ? AND status NOT IN ('completed', 'cancelled')
    `).all(this.validatorAgentId, `%${taskId}%`);

    // 精确匹配 originalTaskId
    const existingValidationTask = potentialDuplicates.find(t => {
      try {
        const ctx = JSON.parse(t.context || '{}');
        return ctx.originalTaskId === taskId;
      } catch {
        return false;
      }
    });

    if (existingValidationTask) {
      console.log(`[ValidationDispatch] 验证任务已存在 (status=${existingValidationTask.status})，跳过创建: ${existingValidationTask.id}`);
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
4. **验证完成后必须提交验证报告**：使用下方提供的 curl 命令

### 重要：数据访问方式
如果需要访问 DuckDB 数据库：
- **不要**直接执行 \`duckdb <file>\` 命令（系统未安装 duckdb CLI）
- **正确方式**：使用 Python 调用 duckdb 库
\`\`\`bash
python3 -c "import duckdb; conn = duckdb.connect('/path/to/file.duckdb', read_only=True); print(conn.execute('SELECT * FROM table_name LIMIT 5').fetchall())"
\`\`\`

### 遇到问题时怎么办
1. **命令执行失败**：先检查命令是否正确，确认工具是否可用
2. **缺乏背景信息**：可以调用 \`GET /api/agents/${this.validatorAgentId}/todos/__TASK_ID__/context\` 获取任务的完整上下文和历史讨论
3. **需要帮助**：如果遇到无法解决的问题，可以调用 \`POST /api/agents/${this.validatorAgentId}/todos/__TASK_ID__/request-help\` 请求人工介入
4. **连续失败**：如果同一命令连续失败 3 次，尝试使用替代方案，不要重复失败的操作

### ⚠️ 重要：验证任务不需要调用 proposeCompletion
- **不要使用** \`proposeCompletion\` 工具
- **正确做法**：验证完成后直接调用 REST API 提交验证报告（见下方）

### 可用 API 接口
\`\`\`
# 获取任务详细信息
GET http://localhost:3000/api/agents/${this.validatorAgentId}/todos/__TASK_ID__

# 获取任务上下文和历史
GET http://localhost:3000/api/agents/${this.validatorAgentId}/todos/__TASK_ID__/context

# 遇到问题时请求帮助
POST http://localhost:3000/api/agents/${this.validatorAgentId}/todos/__TASK_ID__/request-help
Body: { "issue": "问题描述", "whatTried": "尝试过的方法" }

# 提交验证报告（使用下方现成的 curl 命令）
\`\`\`bash
curl -X POST http://localhost:3000/api/agents/${executorAgentId}/todos/${taskId}/validation-report \\
  -H "X-Agent-Secret: ${validatorAgent.secret_key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "validatorAgentId": "'${this.validatorAgentId}'",
    "pass": true,
    "reason": "验证通过原因",
    "feedback": "详细反馈和建议",
    "score": 90
  }'
\`\`\`

你可以修改上面 curl 命令中的 pass、reason、feedback、score 字段来提交你自己的验证报告！
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
      assigned_agent_id: this.validatorAgentId
    });

    validationTask.description = validationTask.description.replace(/__TASK_ID__/g, validationTask.id);
    Todo.update(this.validatorAgentId, validationTask.id, { description: validationTask.description });

    FocusState.createOrUpdate(this.validatorAgentId, {
      current_task_id: validationTask.id,
      updated_at: new Date().toISOString()
    });

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
