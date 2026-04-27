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
  async processMessage(userMessage, conversationHistory = []) {
    const startTime = Date.now();
    
    const context = await this.prepareContext();
    const enhancedPrompt = await this.buildEnhancedPrompt(userMessage, context);
    const response = await this.generateResponse(enhancedPrompt, conversationHistory);
    
    await this.postProcess(response, userMessage);
    
    const metrics = {
      duration: Date.now() - startTime,
      modulesActive: Object.keys(this.modules).length,
      llmAvailable: this.modules.llmManager?.hasProvider()
    };

    return {
      response,
      context,
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
   * 生成回复
   */
  async generateResponse(enhancedPrompt, conversationHistory = []) {
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

      return {
        message: result.content,
        usage: result.usage
      };
    } catch (error) {
      this.log(`❌ LLM生成失败: ${error.message}`);
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
      await this.modules.taskManager.analyzeAndUpdate(response);
    }

    if (this.modules.memoryManager && this.config.features.memoryManagement.autoSummarize) {
      await this.modules.memoryManager.extractAndStore(response, userMessage);
    }

    if (this.modules.proactiveManager) {
      const reminder = await this.modules.proactiveManager.shouldRemind();
      if (reminder) {
        response.reminder = reminder;
      }
    }
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
