/**
 * Agent Task Framework - 智能体任务聚焦框架
 * 
 * 设计理念：
 * 1. 框架完整，一步到位
 * 2. 功能模块化，逐步开放
 * 3. 配置驱动，灵活定制
 * 4. LLM驱动，智能交互
 */

class AgentTaskFramework {
  constructor(config = {}) {
    this.config = this.mergeConfig(config);
    this.modules = {};
    this.initialized = false;
    this.pendingCreations = [];      // 待用户确认创建的任务
    this.pendingCompletions = [];    // 待用户确认完成的任务
    this.lastFocusTaskId = null;     // 上次聚焦的任务ID（用于检测切换）
    this.heartbeatTimer = null;      // 心跳定时器
    this.currentHeartbeatTaskId = null; // 当前正在心跳的任务
    this.localCache = this._loadLocalCache(); // 本地缓存（熔断时使用）
    this.health = 'healthy';         // healthy / degraded / failed
    this.failCount = 0;              // API 失败计数
  }

  /**
   * 合并默认配置和用户配置
   */
  mergeConfig(userConfig) {
    const defaultConfig = {
      base: {
        todoServerUrl: 'http://localhost:3000',
        agentId: null,
        enableLogging: true
      },

      features: {
        taskManagement: {
          enabled: false,
          autoCreateTasks: false,
          autoUpdateStatus: false,
          priority: 'medium'
        },

        contextManagement: {
          enabled: false,
          injectInterval: 'every_turn',
          maxContextLength: 2000,
          includeCompleted: false,
          prioritizeBy: 'priority'
        },

        memoryManagement: {
          enabled: false,
          memoryTypes: ['task_history', 'key_decisions', 'important_facts'],
          memoryRetention: 7,
          autoSummarize: false
        },

        promptManagement: {
          enabled: false,
          systemPrompt: '',
          autoEnhance: false,
          addChecklist: false,
          addProgress: false
        },

        proactiveInteraction: {
          enabled: false,
          remindInterval: 5,
          suggestOnIdle: true,
          blockOffTopic: false
        },

        dependencyManagement: {
          enabled: false,
          autoDetect: false,
          blockOnMissing: false,
          showBlockers: true
        }
      },

      llm: {
        provider: null,
        apiKey: null,
        model: null,
        temperature: 0.7,
        maxTokens: 2000
      }
    };

    return this.deepMerge(defaultConfig, userConfig);
  }

  deepMerge(target, source) {
    const output = { ...target };
    
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (this.isObject(source[key]) && this.isObject(target[key])) {
          output[key] = this.deepMerge(target[key], source[key]);
        } else {
          output[key] = source[key];
        }
      }
    }
    
    return output;
  }

  isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  /**
   * 初始化框架
   */
  async initialize() {
    if (this.initialized) {
      console.log('框架已经初始化');
      return this;
    }

    this.log('🚀 开始初始化 Agent Task Framework...');

    if (this.config.features.taskManagement.enabled) {
      const TaskManager = require('../modules/TaskManager');
      this.modules.taskManager = new TaskManager(this);
      await this.modules.taskManager.initialize();
    }

    if (this.config.features.contextManagement.enabled) {
      const ContextManager = require('../modules/ContextManager');
      this.modules.contextManager = new ContextManager(this);
      await this.modules.contextManager.initialize();
    }

    if (this.config.features.memoryManagement.enabled) {
      const MemoryManager = require('../modules/MemoryManager');
      this.modules.memoryManager = new MemoryManager(this);
      await this.modules.memoryManager.initialize();
    }

    if (this.config.features.promptManagement.enabled) {
      const PromptManager = require('../modules/PromptManager');
      this.modules.promptManager = new PromptManager(this);
      await this.modules.promptManager.initialize();
    }

    if (this.config.features.proactiveInteraction.enabled) {
      const ProactiveManager = require('../modules/ProactiveManager');
      this.modules.proactiveManager = new ProactiveManager(this);
      await this.modules.proactiveManager.initialize();
    }

    if (this.config.features.dependencyManagement.enabled) {
      if (!this.modules.taskManager) {
        const TaskManager = require('../modules/TaskManager');
        this.modules.taskManager = new TaskManager(this);
        await this.modules.taskManager.initialize();
      }
    }

    const LLMManager = require('../llm/LLMManager');
    this.modules.llmManager = new LLMManager(this);
    await this.modules.llmManager.initialize();

    this.initialized = true;
    this.log('✅ 框架初始化完成');

    return this;
  }

  /**
   * 核心方法：处理用户消息
   */
  async processMessage(userMessage, conversationHistory = [], options = {}) {
    const startTime = Date.now();

    // === 前置检查 1：用户是否确认了待创建的任务 ===
    const confirmedCreations = await this._checkTaskCreationConfirmation(userMessage);
    let preMessage = '';
    if (confirmedCreations.length > 0) {
      preMessage = confirmedCreations.map(c => `✅ 已创建任务：${c.title}`).join('\n') + '\n\n';
    }

    // === 前置检查 2：用户是否确认了待完成的任务 ===
    const confirmedCompletions = await this._checkTaskCompletionConfirmation(userMessage);
    if (confirmedCompletions.length > 0) {
      preMessage += confirmedCompletions.map(c => `✅ 任务已完成：${c.title}`).join('\n') + '\n\n';
    }
    
    // === 前置检查 3：聚焦任务是否切换 ===
    const focusChangeInfo = await this._checkFocusChange();
    
    let response;
    if (options.executionMode) {
      const execSystemPrompt = `你是 TODO Server 的智能体工作进程。你的唯一职责是**实际执行分配给你的任务**。

核心原则：
1. 不要汇报系统状态，不要生成任务统计表格
2. 根据任务描述，输出具体的 shell 命令来推进工作
3. 使用 \`\`\`bash 代码块包裹每一条需要执行的命令
4. 命令会被自动执行，执行结果会反馈给你
5. 根据执行结果继续下一步，形成闭环
6. 回复格式必须包含：进度: XX%、步骤: 一句话描述、下一步计划

记住：你是执行者，不是汇报员。`;
      response = await this.generateResponseRaw(userMessage, conversationHistory, execSystemPrompt);
    } else if (options.tools && options.tools.length > 0) {
      response = await this.generateResponseRaw(
        userMessage,
        conversationHistory,
        options.systemPrompt || '',
        options.tools
      );
      if (response.toolCalls && response.toolCalls.length > 0) {
        const { StructuredDriveTools } = require('../../../src/utils/StructuredDriveTools');
        const taskId = options.taskId || this.currentHeartbeatTaskId;
        const sessionId = options.sessionId || 'structured-drive';
        const agentId = options.agentId || this.config.base?.agentId;
        const toolResults = await StructuredDriveTools.executeToolCalls(
          response.toolCalls,
          agentId,
          taskId,
          sessionId
        );
        response.toolResults = toolResults;
      }
    } else {
      const context = await this.prepareContext();
      const enhancedPrompt = await this.buildEnhancedPrompt(userMessage, context);
      response = await this.generateResponse(enhancedPrompt, conversationHistory);
    }

    // 追加前置消息
    if (preMessage) {
      response.message = preMessage + response.message;
    }
    // 追加聚焦切换通知
    if (focusChangeInfo) {
      response.message = focusChangeInfo + '\n\n' + response.message;
    }
    
    // 保存对话上下文到 TODO Server
    await this._saveConversationContext(userMessage, response.message);
    
    await this.postProcess(response, userMessage);
    
    const metrics = {
      duration: Date.now() - startTime,
      modulesActive: Object.keys(this.modules).length,
      llmAvailable: this.modules.llmManager?.hasProvider()
    };

    return {
      response,
      context: options.executionMode ? {} : await this.prepareContext(),
      metrics
    };
  }

  /**
   * 准备上下文
   */
  async prepareContext() {
    const context = {
      timestamp: new Date().toISOString(),
      features: {}
    };

    if (this.modules.contextManager) {
      context.features.contextSummary = await this.modules.contextManager.getSummary();
    }

    if (this.modules.taskManager) {
      context.features.taskInfo = await this.modules.taskManager.getTaskInfo();
    }

    if (this.modules.memoryManager) {
      context.features.memory = await this.modules.memoryManager.getRecentMemory();
    }

    // 注入当前聚焦任务信息
    const focusTask = await this.getCurrentFocusTask();
    if (focusTask) {
      context.features.focusTask = focusTask;
    }

    return context;
  }

  /**
   * 构建增强的Prompt
   */
  async buildEnhancedPrompt(userMessage, context) {
    const promptParts = [];

    if (this.modules.promptManager) {
      const systemPrompt = await this.modules.promptManager.getSystemPrompt();
      promptParts.push(systemPrompt);
    }

    if (context.features.taskInfo) {
      const taskInfo = context.features.taskInfo;
      promptParts.push(`=== 当前任务状态 ===
- 总任务: ${taskInfo.total}
- 待处理: ${taskInfo.pending}
- 进行中: ${taskInfo.inProgress}
- 已完成: ${taskInfo.completed}
- 被阻塞: ${taskInfo.blocked}

${taskInfo.priorityTasks.length > 0 ? `🎯 优先任务:
${taskInfo.priorityTasks.map((t, i) => `${i + 1}. [${t.priority.toUpperCase()}] ${t.title}`).join('\n')}` : ''}

${taskInfo.blockedTasks.length > 0 ? `🚧 被阻塞的任务:
${taskInfo.blockedTasks.map(t => `- ${t.title} (等待: ${t.waitingOn.join(', ')})`).join('\n')}` : ''}`);
    }

    // 注入聚焦任务详细信息
    if (context.features.focusTask) {
      const ft = context.features.focusTask;
      promptParts.push(`=== 📋 当前聚焦任务 ===
任务：${ft.title}
状态：${ft.status}
优先级：${ft.priority}
${ft.description ? `描述：${ft.description}` : ''}
${ft.acceptance_criteria ? `验收标准：\n${ft.acceptance_criteria}` : ''}
${ft.heartbeat_progress > 0 ? `进度：${Math.round(ft.heartbeat_progress * 100)}%` : ''}
${ft.heartbeat_step ? `当前步骤：${ft.heartbeat_step}` : ''}`);
    }

    if (this.config.features.promptManagement.addChecklist) {
      promptParts.push(`=== 工作检查清单 ===
□ 我的下一步行动是否在TODO列表中？
□ 我的当前任务优先级是否正确？
□ 我是否完成了之前的承诺？
□ 我的工作是否偏离了原始目标？`);
    }

    if (context.features.memory && context.features.memory.length > 0) {
      promptParts.push(`=== 历史重要信息 ===
${context.features.memory.map(m => `- ${m.content} (${m.timestamp})`).join('\n')}`);
    }

    return promptParts.join('\n\n');
  }

  /**
   * 生成回复（原始模式，跳过 prompt 增强，用于 Worker 执行模式）
   */
  async generateResponseRaw(userMessage, conversationHistory = [], systemPrompt = '', tools = null) {
    const llmStartTime = Date.now();

    if (!this.modules.llmManager.hasProvider()) {
      return this.generateResponse(userMessage, conversationHistory);
    }

    try {
      const messages = conversationHistory.map(msg => ({
        role: msg.role || 'user',
        content: msg.content || msg.message
      }));

      const requestParams = {
        messages,
        system: systemPrompt,
        userContent: userMessage
      };
      if (tools) requestParams.tools = tools;

      const result = await this.modules.llmManager.chat(requestParams);

      const llmDuration = Date.now() - llmStartTime;
      if (this.currentHeartbeatTaskId) {
        await this._sendHeartbeat(this.currentHeartbeatTaskId, {
          step: `LLM 响应中 (${Math.round(llmDuration / 1000)}s)`,
          extra: { llmDuration }
        });
      }

      return {
        message: result.content,
        usage: result.usage,
        llmDuration,
        toolCalls: result.toolCalls || null
      };
    } catch (error) {
      this.log(`❌ LLM生成失败: ${error.message}`);
      if (this.currentHeartbeatTaskId) {
        await this._sendHeartbeat(this.currentHeartbeatTaskId, {
          step: 'LLM 调用失败，尝试恢复中',
          blockers: [`LLM 错误: ${error.message}`]
        });
      }
      return {
        message: `抱歉，生成回复时出现错误：${error.message}`,
        usage: { error: true }
      };
    }
  }

  /**
   * 生成回复
   */
  async generateResponse(enhancedPrompt, conversationHistory = []) {
    const llmStartTime = Date.now();

    if (!this.modules.llmManager.hasProvider()) {
      this.log('🤖 使用模拟模式（无LLM配置）');
      
      let responseText = `✅ 框架已准备就绪！

当前状态：
- 任务总数: ${this.modules.taskManager ? (await this.modules.taskManager.getTaskInfo()).total : 0}
- LLM状态: 未配置
- 活跃模块: ${Object.keys(this.modules).length}

💡 要启用真实的AI对话，请在配置中添加：

const config = {
  llm: {
    provider: 'openai',      // 或 'anthropic'
    apiKey: 'your-api-key',
    model: 'gpt-3.5-turbo'   // 或 'claude-3-5-haiku-20241022'
  },
  features: {
    taskManagement: { enabled: true },
    promptManagement: { enabled: true }
  }
};`;

      if (this.modules.taskManager) {
        const taskInfo = await this.modules.taskManager.getTaskInfo();
        if (taskInfo.total > 0) {
          responseText += `

📋 任务信息：
- 总计: ${taskInfo.total}
- 待处理: ${taskInfo.pending}
- 已完成: ${taskInfo.completed}
- 被阻塞: ${taskInfo.blocked}`;

          if (taskInfo.priorityTasks.length > 0) {
            responseText += `

🎯 优先任务：`;
            taskInfo.priorityTasks.forEach(t => {
              responseText += `
- [${t.priority.toUpperCase()}] ${t.title}`;
            });
          }
        }
      }

      return {
        message: responseText,
        usage: { prompt_tokens: 0, completion_tokens: 0 }
      };
    }

    try {
      let systemPrompt = '';
      if (this.modules.promptManager) {
        systemPrompt = await this.modules.promptManager.getSystemPrompt();
      }

      const messages = conversationHistory.map(msg => ({
        role: msg.role || 'user',
        content: msg.content || msg.message
      }));

      const userContent = enhancedPrompt + '\n\n用户消息：' + (await this.getUserContext());

      const result = await this.modules.llmManager.chat({
        messages,
        system: systemPrompt,
        userContent: userContent
      });

      // 记录 LLM 调用耗时到心跳（帮助识别 LLM 卡顿）
      const llmDuration = Date.now() - llmStartTime;
      if (this.currentHeartbeatTaskId) {
        await this._sendHeartbeat(this.currentHeartbeatTaskId, {
          step: `LLM 响应中 (${Math.round(llmDuration / 1000)}s)`,
          extra: { llmDuration }
        });
      }

      return {
        message: result.content,
        usage: result.usage,
        llmDuration
      };
    } catch (error) {
      this.log(`❌ LLM生成失败: ${error.message}`);
      // LLM 调用失败时上报阻塞原因
      if (this.currentHeartbeatTaskId) {
        await this._sendHeartbeat(this.currentHeartbeatTaskId, {
          step: 'LLM 调用失败，尝试恢复中',
          blockers: [`LLM 错误: ${error.message}`]
        });
      }
      return {
        message: `抱歉，生成回复时出现错误：${error.message}`,
        usage: { error: true }
      };
    }
  }

  /**
   * 获取用户上下文信息
   */
  async getUserContext() {
    let context = '';

    if (this.modules.taskManager) {
      const taskInfo = await this.modules.taskManager.getTaskInfo();
      if (taskInfo.total > 0) {
        context += '\n\n📋 当前有 ' + taskInfo.total + ' 个任务';
        if (taskInfo.pending > 0) {
          context += '，其中 ' + taskInfo.pending + ' 个待处理';
        }
      }
    }

    if (this.modules.memoryManager) {
      const memory = await this.modules.memoryManager.getRecentMemory();
      if (memory.length > 0) {
        context += '\n\n💭 最近记忆：' + memory[0]?.content?.substring(0, 50) + '...';
      }
    }

    return context;
  }

  /**
   * 后处理
   */
  async postProcess(response, userMessage) {
    if (this.modules.taskManager && this.config.features.taskManagement.autoUpdateStatus) {
      await this.modules.taskManager.analyzeAndUpdate(response, userMessage);
    }

    if (this.modules.memoryManager && this.config.features.memoryManagement.autoSummarize) {
      await this.memoryManager.extractAndStore(response, userMessage);
    }

    if (this.modules.proactiveManager) {
      const reminder = await this.modules.proactiveManager.shouldRemind();
      if (reminder) {
        response.reminder = reminder;
      }
    }

    // 新增：LLM 语义偏离检测 + 纠偏提示
    if (this.modules.proactiveManager && this.config.features.proactiveInteraction.blockOffTopic) {
      try {
        const currentTask = await this.getCurrentFocusTask();
        if (currentTask) {
          const drift = await this.modules.proactiveManager.detectDrift(
            userMessage,
            response.message,
            currentTask
          );

          if (drift.is_drifted && drift.drift_score >= 0.6) {
            const alert = this.modules.proactiveManager.getDriftAlert(drift, currentTask);
            if (alert) {
              response.drift_alert = alert;
              response.message += '\n\n---\n' + alert.content;
              this.log(`🚨 检测到对话偏离（${Math.round(drift.drift_score * 100)}%）：${currentTask.title}`);
            }
          }
        }
      } catch (error) {
        this.log(`⚠️ 偏离检测失败: ${error.message}`);
      }
    }

    // 新增：任务完成确认提议（如果智能体判断可能完成）
    if (this.modules.taskManager && this.config.features.taskManagement.autoUpdateStatus) {
      try {
        const currentTask = await this.getCurrentFocusTask();
        if (currentTask && currentTask.status === 'in_progress') {
          const shouldPropose = await this._shouldProposeCompletion(userMessage, response.message, currentTask);
          if (shouldPropose) {
            this._proposeTaskCompletion(response, currentTask);
            // 启动心跳（如果还没启动）
            this._startHeartbeat(currentTask.id);
          }
        }
      } catch (error) {
        this.log(`⚠️ 完成确认提议失败: ${error.message}`);
      }
    }

    // 新增：主动发现新任务（需用户确认）
    if (this.modules.taskManager && this.config.features.taskManagement.autoCreateTasks) {
      try {
        const conversationText = userMessage + '\n' + (response.message || '');
        const candidates = await this.modules.taskManager.discoverNewTasks(conversationText);
        if (candidates.length > 0) {
          this._proposeTaskCreations(response, candidates);
        }
      } catch (error) {
        this.log(`⚠️ 任务发现失败: ${error.message}`);
      }
    }
  }

  /**
   * 获取当前聚焦任务
   */
  async getCurrentFocusTask() {
    try {
      if (this.modules.taskManager && this.modules.taskManager.todo) {
        const focusResult = await this.modules.taskManager.todo.getFocus();
        if (focusResult.data && focusResult.data.current_task) {
          return focusResult.data.current_task;
        }
      }
    } catch (error) {
      // Focus API 可能不可用，静默忽略
    }
    return null;
  }

  // ==================== P0-2: 验收标准确认流程 ====================

  /**
   * 为任务生成验收标准（LLM 驱动）
   */
  async _generateAcceptanceCriteria(taskTitle, taskDescription, context) {
    const llmManager = this.modules.llmManager;
    if (!llmManager || !llmManager.hasProvider()) {
      return '';
    }

    const prompt = `请为以下任务生成具体的、可验证的验收标准：

任务：${taskTitle}
描述：${taskDescription || '无'}
上下文：${context || '无'}

要求：
1. 每条标准必须是可验证的（能明确判断是否达成）
2. 使用编号列表格式
3. 包含数量、时间、质量等可量化指标
4. 不要写模糊的要求如"做好"、"完善"

只返回验收标准文本，不要包含其他内容。`;

    try {
      const result = await llmManager.chat({
        messages: [{ role: 'user', content: prompt }]
      });
      return result.content || '';
    } catch (error) {
      this.log(`⚠️ 生成验收标准失败: ${error.message}`);
      return '';
    }
  }

  /**
   * 向用户展示验收标准并请求确认
   */
  _proposeAcceptanceCriteria(response, task, criteria) {
    const proposal = `\n\n---\n📋 **验收标准确认**

任务：${task.title}

建议的验收标准：
${criteria}

请确认以上验收标准是否合适。
回复「确认」开始执行，或告诉我需要修改的地方。`;

    response.message += proposal;
    // 标记此任务正在等待验收标准确认
    task._awaitingCriteriaConfirmation = true;
    task._proposedCriteria = criteria;
  }

  // ==================== P0-3: 显式确认完成任务 ====================

  /**
   * 检查用户是否确认了待完成的任务
   */
  async _checkTaskCompletionConfirmation(userMessage) {
    if (this.pendingCompletions.length === 0) return [];

    const msg = userMessage.toLowerCase().trim();
    const confirmed = [];
    const remaining = [];

    for (const pending of this.pendingCompletions) {
      let shouldComplete = false;

      if (msg.includes('确认') || msg.includes('完成') || msg.includes('是的') || msg.includes('没错')) {
        shouldComplete = true;
      } else if (msg.includes('标记完成') || msg.includes('done')) {
        shouldComplete = true;
      }

      if (shouldComplete) {
        try {
          await this.modules.taskManager.todo.completeTodoWithConfirm(pending.id);
          confirmed.push(pending);
          this.log(`✅ 用户确认完成任务: ${pending.title}`);
          // 停止心跳
          this._stopHeartbeat();
        } catch (error) {
          this.log(`❌ 完成任务失败: ${error.message}`);
          remaining.push(pending);
        }
      } else if (msg.includes('还没') || msg.includes('没有') || msg.includes('继续') || msg.includes('不对')) {
        // 用户说还没完成，取消 pending
        this.log(`📝 用户表示任务未完成，继续执行: ${pending.title}`);
        // 记录一次失败尝试
        try {
          await this.modules.taskManager.todo.recordAttempt(pending.id, {
            success: false,
            reason: '用户确认尚未完成',
            output: msg
          });
        } catch (e) {
          // ignore
        }
      } else {
        remaining.push(pending);
      }
    }

    this.pendingCompletions = remaining;
    return confirmed;
  }

  /**
   * 判断是否应该提议完成任务
   */
  async _shouldProposeCompletion(userMessage, assistantReply, currentTask) {
    // 如果任务已经有待确认完成，不再提议
    if (this.pendingCompletions.some(p => p.id === currentTask.id)) {
      return false;
    }

    // 如果没有验收标准，不提议完成
    if (!currentTask.acceptance_criteria) {
      return false;
    }

    const llmManager = this.modules.llmManager;
    if (!llmManager || !llmManager.hasProvider()) {
      // 回退：检查对话中是否有完成关键词
      const text = (userMessage + ' ' + assistantReply).toLowerCase();
      return /完成|搞定|done|finished/.test(text);
    }

    const prompt = `分析以下对话，判断任务是否已经完成。

任务：${currentTask.title}
验收标准：
${currentTask.acceptance_criteria}

对话：
用户：${userMessage}
助手：${assistantReply}

请判断是否所有验收标准都已达成。
只返回 JSON：{"completed": true/false, "confidence": 0.0-1.0, "checklist": [{"item": "标准内容", "passed": true/false}]}`;

    try {
      const result = await llmManager.chat({
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = result.content || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return false;
      const analysis = JSON.parse(jsonMatch[0]);
      return analysis.completed === true && analysis.confidence >= 0.7;
    } catch (error) {
      return false;
    }
  }

  /**
   * 向用户提议完成任务
   */
  _proposeTaskCompletion(response, task) {
    let checklist = '';
    if (task.acceptance_criteria) {
      const items = task.acceptance_criteria.split('\n').filter(line => line.trim());
      checklist = items.map((item, i) => `${i + 1}. ${item.trim()}`).join('\n');
    }

    const proposal = `\n\n---\n✅ **任务完成确认**

我判断「${task.title}」可能已完成。

${checklist ? `验收标准：\n${checklist}\n` : ''}
请回复「确认」标记任务完成。
如果还没完成，请告诉我哪里还需要继续。`;

    response.message += proposal;
    this.pendingCompletions.push({
      id: task.id,
      title: task.title
    });
  }

  // ==================== P1-4: 子任务切换感知 ====================

  /**
   * 检查聚焦任务是否切换
   */
  async _checkFocusChange() {
    const currentTask = await this.getCurrentFocusTask();
    if (!currentTask) {
      this.lastFocusTaskId = null;
      return null;
    }

    // 首次聚焦
    if (!this.lastFocusTaskId) {
      this.lastFocusTaskId = currentTask.id;
      if (currentTask.status === 'pending') {
        await this._autoStartTask(currentTask);
      }
      return `📋 当前聚焦任务：${currentTask.title}\n${currentTask.acceptance_criteria ? '验收标准：\n' + currentTask.acceptance_criteria : ''}`;
    }

    // 聚焦切换
    if (this.lastFocusTaskId !== currentTask.id) {
      const prevTaskId = this.lastFocusTaskId;
      this.lastFocusTaskId = currentTask.id;

      // 获取上一个任务信息（用于显示"已完成"）
      let prevTaskTitle = '';
      try {
        const prev = await this.modules.taskManager.getTask(prevTaskId);
        if (prev) prevTaskTitle = prev.title;
      } catch (e) {
        // ignore
      }

      // 自动开始新聚焦的任务
      if (currentTask.status === 'pending') {
        await this._autoStartTask(currentTask);
      }

      return `=== 子任务切换 ===\n${prevTaskTitle ? '已完成：' + prevTaskTitle + ' ✅\n' : ''}当前聚焦：${currentTask.title}\n${currentTask.acceptance_criteria ? '验收标准：\n' + currentTask.acceptance_criteria : ''}`;
    }

    return null;
  }

  /**
   * 自动开始任务：标记为 in_progress 并启动心跳
   */
  async _autoStartTask(task) {
    try {
      if (this.modules.taskManager) {
        await this.modules.taskManager.startTask(task.id);
        this.log(`▶️ 自动开始任务: ${task.title}`);
      }
      this._startHeartbeat(task.id);
    } catch (error) {
      this.log(`⚠️ 自动开始任务失败: ${error.message}`);
    }
  }

  // ==================== P1-5: 熔断 + 本地缓存 ====================

  /**
   * 带熔断的 API 调用
   */
  async _callWithCircuitBreaker(apiCall, fallbackValue = null) {
    if (this.health === 'failed') {
      return fallbackValue;
    }

    try {
      const result = await apiCall();
      this.failCount = 0;
      if (this.health === 'degraded') {
        this.health = 'healthy';
        this.log('✅ TODO Server 恢复，熔断解除');
      }
      return result;
    } catch (error) {
      this.failCount++;
      if (this.failCount >= 3) {
        this.health = 'failed';
        this.log('🚨 TODO Server 连续失败，进入熔断模式');
        // 保存当前状态到本地缓存
        this._saveLocalCache();
      } else if (this.failCount >= 2) {
        this.health = 'degraded';
        this.log('⚠️ TODO Server 响应异常，进入降级模式');
      }
      return fallbackValue;
    }
  }

  /**
   * 加载本地缓存
   */
  _loadLocalCache() {
    try {
      const fs = require('fs');
      const path = require('path');
      const cachePath = path.join(
        require('os').homedir(),
        '.hermes', 'skills', 'todo', 'cache',
        `${this.config.base.agentId || 'default'}.json`
      );
      if (fs.existsSync(cachePath)) {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        this.log('💾 已加载本地缓存');
        return data;
      }
    } catch (error) {
      this.log('⚠️ 加载本地缓存失败');
    }
    return { focus: null, context: null, tasks: [] };
  }

  /**
   * 保存本地缓存
   */
  _saveLocalCache() {
    try {
      const fs = require('fs');
      const path = require('path');
      const cachePath = path.join(
        require('os').homedir(),
        '.hermes', 'skills', 'todo', 'cache',
        `${this.config.base.agentId || 'default'}.json`
      );
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(cachePath, JSON.stringify(this.localCache, null, 2), 'utf-8');
    } catch (error) {
      this.log('⚠️ 保存本地缓存失败');
    }
  }

  // ==================== P1-7: 对话上下文外置存储 ====================

  /**
   * 保存对话上下文到 TODO Server
   */
  async _saveConversationContext(userMessage, assistantReply) {
    if (!this.modules.taskManager || !this.modules.taskManager.todo) return;

    const sessionId = this._getSessionId();
    try {
      await this.modules.taskManager.todo.saveContext(sessionId, 'user', userMessage, {});
      await this.modules.taskManager.todo.saveContext(sessionId, 'assistant', assistantReply, {});
    } catch (error) {
      // 静默忽略，对话存储不是关键路径
    }
  }

  _getSessionId() {
    // 使用日期作为 session ID（每天一个 session）
    return new Date().toISOString().split('T')[0];
  }

  // ==================== P1-8: 心跳机制 ====================

  /**
   * 启动心跳
   */
  _startHeartbeat(taskId) {
    if (this.heartbeatTimer) {
      if (this.currentHeartbeatTaskId === taskId) {
        return; // 已经在心跳同一个任务
      }
      this._stopHeartbeat();
    }

    this.currentHeartbeatTaskId = taskId;
    this.heartbeatTimer = setInterval(() => {
      this._sendHeartbeat(taskId);
    }, 60000); // 每 1 分钟

    this.log(`💓 启动心跳监控：任务 ${taskId}`);
    // 立即发送一次心跳
    this._sendHeartbeat(taskId);
  }

  /**
   * 停止心跳
   */
  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.currentHeartbeatTaskId = null;
      this.log('🛑 停止心跳监控');
    }
  }

  /**
   * 发送心跳
   */
  async _sendHeartbeat(taskId, override = null) {
    try {
      if (this.modules.taskManager && this.modules.taskManager.todo) {
        let payload = override;
        if (!payload) {
          // 无覆盖时读取当前任务状态，避免覆盖 Worker 解析的进度
          try {
            const taskResult = await this.modules.taskManager.todo.getTodo(taskId);
            const task = taskResult.data || taskResult;
            if (task) {
              payload = {
                progress: task.heartbeat_progress || 0,
                step: task.heartbeat_step || '执行中',
                blockers: Array.isArray(task.heartbeat_blockers)
                  ? task.heartbeat_blockers
                  : JSON.parse(task.heartbeat_blockers || '[]')
              };
            }
          } catch (e) {
            // 读取失败时使用默认值
          }
        }
        payload = payload || {
          progress: 0.5,
          step: '执行中',
          blockers: []
        };
        await this.modules.taskManager.todo.updateHeartbeat(taskId, payload);
      }
    } catch (error) {
      // 静默忽略
    }
  }

  // ==================== P0-2 延续: 任务创建确认 ====================

  /**
   * 检查用户是否确认了待创建的任务
   */
  async _checkTaskCreationConfirmation(userMessage) {
    if (this.pendingCreations.length === 0) return [];

    const msg = userMessage.toLowerCase().trim();
    const toCreate = [];
    const remaining = [];

    for (const pending of this.pendingCreations) {
      let shouldCreate = false;

      // 确认关键词
      if (msg.includes('全部创建') || msg.includes('全部') || msg.includes('创建全部')) {
        shouldCreate = true;
      } else if (msg.includes(`创建${pending.index}`) || msg.includes(`确认${pending.index}`)) {
        shouldCreate = true;
      } else if (msg.includes('创建') && msg.includes(pending.title.substring(0, 6))) {
        shouldCreate = true;
      } else if (msg === '创建' && this.pendingCreations.length === 1) {
        shouldCreate = true;
      }

      if (shouldCreate) {
        toCreate.push(pending);
      } else {
        remaining.push(pending);
      }
    }

    // 分离父任务和子任务
    const parentTasks = toCreate.filter(t => !t.parentTitle);
    const childTasks = toCreate.filter(t => t.parentTitle);
    const confirmed = [];
    const parentIdMap = new Map();

    // 第一步：创建所有父任务
    for (const pending of parentTasks) {
      try {
        const result = await this.modules.taskManager.createTask({
          title: pending.title,
          priority: pending.priority || 'medium',
          context: pending.context || '',
          tags: pending.tags || [],
          acceptanceCriteria: pending.acceptance_criteria || ''
        });
        confirmed.push(pending);
        if (result && result.id) {
          parentIdMap.set(pending.title, result.id);
        }
        this.log(`✅ 用户确认创建父任务: ${pending.title}`);
      } catch (error) {
        this.log(`❌ 创建父任务失败: ${error.message}`);
        remaining.push(pending);
      }
    }

    // 第二步：创建子任务（关联 parentId）
    for (const pending of childTasks) {
      try {
        const parentId = parentIdMap.get(pending.parentTitle);
        await this.modules.taskManager.createTask({
          title: pending.title,
          priority: pending.priority || 'medium',
          context: pending.context || '',
          tags: pending.tags || [],
          parentId: parentId || undefined
        });
        confirmed.push(pending);
        this.log(`✅ 用户确认创建子任务: ${pending.title}${parentId ? ' (parent: ' + pending.parentTitle + ')' : ''}`);
      } catch (error) {
        this.log(`❌ 创建子任务失败: ${error.message}`);
        remaining.push(pending);
      }
    }

    this.pendingCreations = remaining;
    return confirmed;
  }

  /**
   * 向用户提议创建新任务
   */
  _proposeTaskCreations(response, candidates) {
    if (candidates.length === 0) return;

    this.pendingCreations = candidates.map((c, i) => ({ ...c, index: i + 1 }));

    let proposal = '\n\n---\n💡 **任务发现**\n\n我注意到你可能有以下新任务：\n';
    candidates.forEach((task, i) => {
      proposal += `${i + 1}. **${task.title}**`;
      if (task.priority) proposal += ` (${task.priority})`;
      if (task.context) proposal += ` — ${task.context}`;
      proposal += '\n';
    });

    proposal += '\n需要我创建吗？回复「创建1」「创建2」或「全部创建」。不需要请忽略。';
    response.message += proposal;
  }

  /**
   * 启用功能
   */
  enableFeature(featureName) {
    if (this.config.features[featureName]) {
      this.config.features[featureName].enabled = true;
      
      this.log(`✅ 功能已启用: ${featureName}`);
    } else {
      console.warn(`⚠️ 未知的特性: ${featureName}`);
    }
  }

  /**
   * 禁用功能
   */
  disableFeature(featureName) {
    if (this.config.features[featureName]) {
      this.config.features[featureName].enabled = false;
      this.log(`❌ 功能已禁用: ${featureName}`);
    }
  }

  /**
   * 获取状态
   */
  getStatus() {
    const status = {
      initialized: this.initialized,
      activeModules: Object.keys(this.modules),
      enabledFeatures: []
    };

    for (const [feature, config] of Object.entries(this.config.features)) {
      if (config.enabled) {
        status.enabledFeatures.push(feature);
      }
    }

    status.llm = this.modules.llmManager?.getModelInfo();

    return status;
  }

  /**
   * 获取LLM管理器
   */
  getLLMManager() {
    return this.modules.llmManager;
  }

  /**
   * 运行时切换 LLM Provider（快捷方法）
   */
  async swapLLMProvider(newConfig, options = {}) {
    if (!this.modules.llmManager) {
      throw new Error('LLM Manager 未初始化');
    }
    return this.modules.llmManager.swapProvider(newConfig, options);
  }

  /**
   * 获取 LLM 状态
   */
  getLLMStatus() {
    if (!this.modules.llmManager) {
      return { hasProvider: false, primary: null, fallback: null };
    }
    return this.modules.llmManager.getStatus();
  }

  /**
   * 日志
   */
  log(message) {
    if (this.config.base.enableLogging) {
      console.log(`[Framework] ${message}`);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentTaskFramework;
}

if (typeof window !== 'undefined') {
  window.AgentTaskFramework = AgentTaskFramework;
}
