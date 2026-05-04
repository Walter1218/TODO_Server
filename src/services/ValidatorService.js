const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Agent = require('../models/Agent');
const CommandExecutor = require('./CommandExecutor');
const ValidationAgent = require('./ValidationAgent');

const MAX_VALIDATION_COUNT = 3;

class ValidatorService {
  constructor(framework) {
    this.framework = framework;
    this.validationAgent = null;
  }

  _getValidationAgent() {
    if (!this.validationAgent) {
      this.validationAgent = new ValidationAgent(this.framework);
    }
    return this.validationAgent;
  }

  async validateTask(agentId, task) {
    console.log(`[ValidatorService] 开始校验任务: ${task.title} (${task.id})`);

    const currentVC = task.validation_count || 0;
    if (currentVC >= MAX_VALIDATION_COUNT) {
      console.log(`[ValidatorService] 任务 ${task.id} 验证次数已达上限(${currentVC}/${MAX_VALIDATION_COUNT})，跳过验证`);
      return { pass: false, reason: `验证次数已达上限(${currentVC}/${MAX_VALIDATION_COUNT})`, score: 0, exhausted: true };
    }

    if (this.framework.modules.llmManager?.hasProvider()) {
      return this._validateWithAgent(agentId, task);
    }
    return this._validateWithRules(task);
  }

  async _validateWithAgent(agentId, task) {
    try {
      const agent = this._getValidationAgent();
      const validationResult = await agent.validate(agentId, task);

      if (validationResult.exhausted) {
        return validationResult;
      }

      const newCount = (task.validation_count || 0) + 1;
      const isExhausted = newCount >= MAX_VALIDATION_COUNT;
      const updateData = {
        validationCount: newCount,
        validationReport: JSON.stringify(validationResult),
        validatedBy: 'validation-agent'
      };

      if (validationResult.pass) {
        updateData.status = 'completed';
        updateData.heartbeatStep = '✅ ValidationAgent 校验通过';
      } else if (isExhausted) {
        updateData.status = 'blocked';
        updateData.heartbeatStep = `🔒 校验失败已达 ${MAX_VALIDATION_COUNT} 次上限，需要人工介入`;
      } else {
        updateData.status = 'validation_failed';
        updateData.heartbeatStep = `❌ 校验未通过: ${validationResult.reason}`;

        await Context.create(agentId, {
          sessionId: 'drive-orchestrator',
          role: 'system',
          content: `[ValidationAgent] 校验未通过反馈：\n${validationResult.feedback}`,
          metadata: { type: 'validation_feedback', task_id: task.id }
        });
      }

      await Todo.update(agentId, task.id, updateData);
      if (validationResult.pass) {
        Todo.checkAndCompleteParent(agentId, task.id);
      }

      console.log(`[ValidatorService] 任务校验完成(${validationResult.pass ? '通过' : '不通过'}, 得分: ${validationResult.score}, 迭代: ${validationResult.iterations || 1}轮, 工具调用: ${(validationResult.evidence || []).length}次)`);
      return validationResult;
    } catch (err) {
      console.error(`[ValidatorService] ValidationAgent 校验出错: ${err.message}, 回退到规则验证`);
      return this._validateWithRules(task);
    }
  }

  async _validateWithRules(task) {
    const executionLogs = await this._collectLogs(task);
    const actualValidationResults = await this._runValidationCommands(task);
    const validationResultsSummary = actualValidationResults.length > 0
      ? `\n=== 实际验证结果 ===\n${CommandExecutor.buildExecutionSummary(actualValidationResults)}`
      : '';

    const validatorPrompt = `你是一名严谨的软件质量保障工程师（QA Engineer）。
你的任务是审核一个 AI Agent 执行任务的质量，并决定是否通过验收。

=== 任务信息 ===
标题: ${task.title}
描述: ${task.description}
验收标准:
${task.acceptance_criteria || '未设置明确验收标准'}

=== 执行过程日志 ===
${executionLogs}

${validationResultsSummary}

=== 评分指南 ===
- 0-20分: Agent 完全未执行任务（如陷入循环问候）
- 21-40分: Agent 尝试执行但未完成核心任务
- 41-60分: Agent 完成部分核心任务
- 61-80分: Agent 完成核心任务但有一些小问题
- 81-100分: Agent 完美完成任务

=== 回复格式 ===
{
  "pass": true/false,
  "reason": "简要说明通过或失败的原因",
  "feedback": "如果不通过，请给出具体的修正建议；如果通过，请给予肯定",
  "score": 0-100
}

请确保回复仅包含 JSON。`;

    try {
      const result = await this.framework.generateResponseRaw(validatorPrompt, [], "你是一个专业的任务校验智能体。");
      const reply = result.message || '';
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('LLM 回复格式错误，未找到 JSON');
      }

      const validationResult = JSON.parse(jsonMatch[0]);
      const agentId = task.agent_id || 'hermes-ops';
      const newCount = (task.validation_count || 0) + 1;
      const isExhausted = newCount >= MAX_VALIDATION_COUNT;
      const updateData = {
        validationCount: newCount,
        validationReport: JSON.stringify(validationResult),
        validatedBy: 'todo-server-validator-legacy'
      };

      if (validationResult.pass) {
        updateData.status = 'completed';
        updateData.heartbeatStep = '✅ 校验通过(legacy)';
      } else if (isExhausted) {
        updateData.status = 'blocked';
        updateData.heartbeatStep = `🔒 校验失败已达 ${MAX_VALIDATION_COUNT} 次上限，需要人工介入`;
      } else {
        updateData.status = 'validation_failed';
        updateData.heartbeatStep = `❌ 校验未通过: ${validationResult.reason}`;

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
      console.log(`[ValidatorService] 任务校验完成(legacy): ${validationResult.pass ? '通过' : '不通过'} (得分: ${validationResult.score})`);
      return validationResult;
    } catch (err) {
      console.error(`[ValidatorService] legacy 校验出错: ${err.message}`);
      return { pass: false, error: err.message };
    }
  }

  async _collectLogs(task) {
    const agentId = task.agent_id || 'hermes-ops';
    const recent = await Context.findRecentByAgent(agentId, 200);
    const related = recent.filter(c => (c.metadata || {}).task_id === task.id);
    const contexts = related.length > 0 ? related : await Context.findBySession(agentId, 'drive-orchestrator', 40);
    return contexts.map(c => `[${c.session_id || 'session'}][${c.role}] ${c.content}`).join('\n---\n');
  }

  async _runValidationCommands(task) {
    const validationCommands = this.extractValidationCommands(task);
    if (validationCommands.length === 0) return [];
    console.log(`[ValidatorService] 执行 ${validationCommands.length} 个验证命令`);
    return CommandExecutor.executeCommands(validationCommands, {
      timeoutMs: 30000,
      cwd: process.cwd(),
      maxCommands: 10
    });
  }

  extractValidationCommands(task) {
    const commands = [];
    const allText = `${task.description || ''}\n${task.acceptance_criteria || ''}`;

    const duckdbMatches = allText.match(/(\/[\w\/]+\.duckdb)/g);
    if (duckdbMatches) {
      const uniquePaths = [...new Set(duckdbMatches)];
      uniquePaths.forEach((filePath, idx) => {
        commands.push({
          index: idx,
          command: `python3 -c "import duckdb; conn = duckdb.connect('${filePath}'); print('Tables:', conn.execute(\\\"SELECT table_name FROM information_schema.tables\\\").fetchall())"`,
          source: 'validation'
        });
      });
    }

    const sqlMatches = allText.match(/SELECT\s+[\s\S]+?(?=\n|;)/gi);
    if (sqlMatches && duckdbMatches?.[0]) {
      sqlMatches.forEach((sql) => {
        const cleanSql = sql.replace(/["'`]/g, '\\"');
        commands.push({
          index: commands.length,
          command: `python3 -c "import duckdb; conn = duckdb.connect('${duckdbMatches[0]}'); print(conn.execute(\\\"${cleanSql}\\\").fetchall())"`,
          source: 'validation'
        });
      });
    }

    const fileMatches = allText.match(/(\/[\w\/\-\.]+\.(py|json|txt|csv|log))/g);
    if (fileMatches) {
      const uniqueFiles = [...new Set(fileMatches)];
      uniqueFiles.forEach((file) => {
        commands.push({
          index: commands.length,
          command: `ls -la "${file}" 2>/dev/null || echo "File not found: ${file}"`,
          source: 'validation'
        });
      });
    }

    const scriptMatches = allText.match(/fetch_\w+\.py/g);
    if (scriptMatches) {
      const uniqueScripts = [...new Set(scriptMatches)];
      uniqueScripts.forEach((script) => {
        commands.push({
          index: commands.length,
          command: `python3 ${script} --help 2>/dev/null || echo "Script not found or no help: ${script}"`,
          source: 'validation'
        });
      });
    }

    return commands;
  }
}

module.exports = ValidatorService;