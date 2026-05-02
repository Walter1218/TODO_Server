const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Agent = require('../models/Agent');

class ValidatorService {
  constructor(framework) {
    this.framework = framework;
  }

  /**
   * 校验任务是否符合验收标准
   * @param {string} agentId 
   * @param {object} task 
   */
  async validateTask(agentId, task) {
    console.log(`[ValidatorService] 开始校验任务: ${task.title} (${task.id})`);

    // 1. 获取任务相关的上下文（最近的执行日志）
    const recent = await Context.findRecentByAgent(agentId, 200);
    const related = recent.filter(c => (c.metadata || {}).task_id === task.id);
    const contexts = related.length > 0 ? related : await Context.findBySession(agentId, 'drive-orchestrator', 40);

    const executionLogs = contexts
      .map(c => `[${c.session_id || 'session'}][${c.role}] ${c.content}`)
      .join('\n---\n');

    // 2. 构建校验 Prompt
    const validatorPrompt = `你是一名严谨的软件质量保障工程师（QA Engineer）。
你的任务是审核一个 AI Agent 执行任务的质量，并决定是否通过验收。

=== 任务信息 ===
标题: ${task.title}
描述: ${task.description}
验收标准: 
${task.acceptance_criteria || '未设置明确验收标准'}

=== 执行过程日志 ===
${executionLogs}

=== 你的职责 ===
1. 仔细阅读执行日志，查看 Agent 执行了哪些命令，输出了什么结果。
2. 对比验收标准，判断 Agent 是否真正完成了任务。
3. 检查是否有明显的错误、遗漏或安全隐患。

=== 回复格式 ===
你的回复必须是 JSON 格式：
{
  "pass": true/false,
  "reason": "简要说明通过或失败的原因",
  "feedback": "如果不通过，请给出具体的修正建议；如果通过，请给予肯定",
  "score": 0-100 (质量评分)
}

请确保回复仅包含 JSON。`;

    try {
      // 3. 调用 LLM 进行校验
      const result = await this.framework.generateResponseRaw(validatorPrompt, [], "你是一个专业的任务校验智能体。");
      const reply = result.message || '';
      
      // 提取 JSON
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 回复格式错误，未找到 JSON');
      }

      const validationResult = JSON.parse(jsonMatch[0]);
      
      // 4. 更新任务状态
      const newCount = (task.validation_count || 0) + 1;
      const updateData = {
        validationCount: newCount,
        validationReport: JSON.stringify(validationResult),
        validatedBy: 'todo-server-validator'
      };

      if (validationResult.pass) {
        updateData.status = 'completed';
        updateData.heartbeatStep = '✅ 自动化校验通过';
      } else {
        // 如果失败，打回进行中，或者标记为校验失败
        updateData.status = 'validation_failed';
        updateData.heartbeatStep = `❌ 校验未通过: ${validationResult.reason}`;
        
        // 在上下文记录反馈，供下一次执行参考
        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'system',
          content: `[Validator] 校验未通过反馈：\n${validationResult.feedback}`,
          metadata: { type: 'validation_feedback', task_id: task.id }
        });
      }

      await Todo.update(agentId, task.id, updateData);
      if (validationResult.pass) {
        Todo.checkAndCompleteParent(agentId, task.id);
      }
      console.log(`[ValidatorService] 任务校验完成: ${validationResult.pass ? '通过' : '不通过'}`);

      return validationResult;
    } catch (err) {
      console.error(`[ValidatorService] 校验出错: ${err.message}`);
      return { pass: false, error: err.message };
    }
  }
}

module.exports = ValidatorService;
