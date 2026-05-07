const Todo = require('../models/Todo');
const Context = require('../models/Context');
const CommandExecutor = require('./CommandExecutor');
const ValidationAgent = require('./ValidationAgent');
const ValidationPolicyService = require('./ValidationPolicyService');

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

    const policyResult = ValidationPolicyService.validate(task);
    if (policyResult.applied) {
      return this._applyValidationResult(agentId, task, policyResult, policyResult.validator || 'validation-policy');
    }

    if (this.framework.modules.llmManager?.hasProvider()) {
      return this._validateWithAgent(agentId, task);
    }
    return this._validateWithRules(agentId, task);
  }

  async _validateWithAgent(agentId, task) {
    try {
      const agent = this._getValidationAgent();
      const validationResult = await agent.validate(agentId, task);

      if (validationResult.exhausted) {
        return validationResult;
      }
      await this._applyValidationResult(agentId, task, validationResult, 'validation-agent');

      console.log(`[ValidatorService] 任务校验完成(${validationResult.pass ? '通过' : '不通过'}, 得分: ${validationResult.score}, 迭代: ${validationResult.iterations || 1}轮, 工具调用: ${(validationResult.evidence || []).length}次)`);
      return validationResult;
    } catch (err) {
      console.error(`[ValidatorService] ValidationAgent 校验出错: ${err.message}, 回退到规则验证`);
      return this._validateWithRules(agentId, task);
    }
  }

  async _validateWithRules(agentId, task) {
    const executionLogs = await this._collectLogs(task);
    const actualValidationResults = await this._runValidationCommands(task);
    const successfulResults = actualValidationResults.filter(item => item.success);
    const failedResults = actualValidationResults.filter(item => !item.success);
    const evidenceSummary = [];

    if (successfulResults.length > 0) {
      evidenceSummary.push(`验证命令成功 ${successfulResults.length} 条`);
      evidenceSummary.push(...successfulResults.slice(0, 2).map(item => String(item.output || item.stdout || '').substring(0, 120)));
    }
    if (failedResults.length > 0) {
      evidenceSummary.push(...failedResults.slice(0, 2).map(item => `失败: ${String(item.output || item.stderr || '').substring(0, 120)}`));
    }

    let validationResult;
    if (successfulResults.length > 0 && failedResults.length === 0) {
      validationResult = {
        pass: true,
        reason: '验证命令执行成功，规则校验通过',
        feedback: '已通过规则校验，存在可执行的实际验证结果。',
        score: 82,
        evidence_summary: evidenceSummary,
        validator: 'rule:command-verifier'
      };
    } else if (actualValidationResults.length > 0 && successfulResults.length === 0) {
      validationResult = {
        pass: false,
        reason: '验证命令全部失败，缺少可接受的结果证据',
        feedback: '请修复验证命令或补齐结构化产出物后重新提交验收。',
        score: 30,
        evidence_summary: evidenceSummary,
        validator: 'rule:command-verifier'
      };
    } else {
      const hasExecutionTrace = executionLogs && executionLogs.trim().length > 0;
      validationResult = {
        pass: false,
        reason: hasExecutionTrace ? '缺少结构化完成证据和可执行验证命令，暂不自动通过' : '未发现执行证据，暂不自动通过',
        feedback: '请通过 proposeCompletion 补齐结构化 evidence/criteriaMet/artifacts 后再进入自动验收。',
        score: hasExecutionTrace ? 45 : 20,
        evidence_summary: hasExecutionTrace ? ['存在执行日志，但不足以形成结果级验收证据'] : [],
        validator: 'rule:evidence-gate'
      };
    }

    await this._applyValidationResult(agentId, task, validationResult, validationResult.validator || 'rule-validator');
    console.log(`[ValidatorService] 任务校验完成(rule): ${validationResult.pass ? '通过' : '不通过'} (得分: ${validationResult.score})`);
    return validationResult;
  }

  async _applyValidationResult(agentId, task, validationResult, validatedBy) {
    if (validationResult.deferred) {
      const updateData = {
        validationReport: JSON.stringify(validationResult),
        validatedBy,
        status: 'pending',
        failureBucket: null,
        heartbeatProgress: Math.min(task.heartbeat_progress || 95, 95),
        heartbeatStep: `⏸ 自动延期验收: ${validationResult.reason}`
      };
      if (validationResult.deferred_until) {
        updateData.validationDeadline = validationResult.deferred_until;
      }
      await Todo.update(agentId, task.id, updateData);
      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: `[Validator] 数据任务延期验收：\n${validationResult.feedback || validationResult.reason || '源头当日无数据'}`,
        metadata: { type: 'validation_deferred', task_id: task.id, validator: validatedBy }
      });
      return validationResult;
    }

    const newCount = (task.validation_count || 0) + 1;
    const isExhausted = newCount >= MAX_VALIDATION_COUNT;
    const updateData = {
      validationCount: newCount,
      validationReport: JSON.stringify(validationResult),
      validatedBy
    };

    if (validationResult.pass) {
      updateData.status = 'completed';
      updateData.heartbeatStep = '✅ 自动验收通过';
    } else if (isExhausted || validationResult.exhausted) {
      updateData.status = 'blocked';
      updateData.failureBucket = 'validation_failed';
      updateData.heartbeatStep = `🔒 校验失败已达 ${MAX_VALIDATION_COUNT} 次上限，需要人工介入`;
    } else {
      updateData.status = 'validation_failed';
      updateData.failureBucket = 'validation_failed';
      updateData.heartbeatStep = `❌ 校验未通过: ${validationResult.reason}`;

      await Context.create(agentId, {
        sessionId: 'drive-orchestrator',
        role: 'system',
        content: `[Validator] 校验未通过反馈：\n${validationResult.feedback || validationResult.reason || '无反馈'}`,
        metadata: { type: 'validation_feedback', task_id: task.id, validator: validatedBy }
      });
    }

    await Todo.update(agentId, task.id, updateData);
    if (validationResult.pass) {
      Todo.checkAndCompleteParent(agentId, task.id);
    }
    return validationResult;
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
