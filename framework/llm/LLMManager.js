/**
 * LLM Manager
 * 
 * 管理LLM实例，提供统一的接口
 */

const LLMFactory = require('./LLMFactory');

class LLMManager {
  constructor(framework) {
    this.framework = framework;
    this.provider = null;
    this.fallbackProvider = null;
    this.conversationHistory = [];
    this.maxHistoryLength = 50;
  }

  /**
   * 初始化
   */
  async initialize() {
    const config = this.framework.config.llm;

    if (!config || !config.provider) {
      console.warn('⚠️ LLM未配置，将使用模拟模式');
      this.provider = null;
      return;
    }

    // 带超时的连接测试包装器
    const testWithTimeout = async (provider, label, timeoutMs = 8000) => {
      return Promise.race([
        provider.testConnection(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Connection test timeout')), timeoutMs)
        )
      ]).catch(err => ({ success: false, message: err.message }));
    };

    // 初始化主 provider
    try {
      this.provider = LLMFactory.createFromConfig(config);

      const testResult = await testWithTimeout(this.provider, 'primary', 8000);
      if (!testResult.success) {
        console.warn(`⚠️ 主 LLM (${config.provider}) 连接失败: ${testResult.message}`);
        this.provider = null;
      } else {
        this.framework.log('✅ LLM初始化成功');
        this.framework.log(`   Provider: ${config.provider}`);
        this.framework.log(`   Model: ${config.model || 'default'}`);
      }
    } catch (error) {
      console.error(`❌ 主 LLM (${config.provider}) 初始化失败: ${error.message}`);
      this.provider = null;
    }

    // 初始化 fallback provider
    if (config.fallback) {
      try {
        this.fallbackProvider = LLMFactory.createFromConfig(config.fallback);

        const fallbackTest = await testWithTimeout(this.fallbackProvider, 'fallback', 15000);
        if (!fallbackTest.success) {
          console.warn(`⚠️ Fallback LLM (${config.fallback.provider}) 连接失败: ${fallbackTest.message}`);
          this.fallbackProvider = null;
        } else {
          this.framework.log(`✅ Fallback LLM 就绪: ${config.fallback.provider} / ${config.fallback.model || 'default'}`);
        }
      } catch (error) {
        console.warn(`⚠️ Fallback LLM 初始化失败: ${error.message}`);
        this.fallbackProvider = null;
      }
    }

    // 如果主 provider 失败但有 fallback，将 fallback 提升为主 provider
    if (!this.provider && this.fallbackProvider) {
      this.framework.log('🔄 主 LLM 不可用，已切换至 Fallback LLM');
      this.provider = this.fallbackProvider;
      this.fallbackProvider = null;
    }

    if (!this.provider && !this.fallbackProvider) {
      console.warn('⚠️ 无可用 LLM，将使用模拟模式');
    }
  }

  /**
   * 发送聊天请求（带 fallback 和结构化工具调用支持）
   *
   * @param {Object} params
   * @param {Array} params.messages  - 消息列表
   * @param {string} [params.system] - 系统提示词
   * @param {string} [params.userContent] - 附加用户内容
   * @param {Array}  [params.tools]  - 结构化工具定义（OpenAI tool_calls 格式）
   * @returns {Promise<{content, usage, finishReason, toolCalls?}>}
   */
  async chat(params) {
    const { messages, system, userContent, tools } = params;

    if (!this.provider) {
      return this.mockChat(params);
    }

    if (userContent) {
      messages.push({ role: 'user', content: userContent });
    }

    try {
      const requestParams = { messages, system };
      if (tools && tools.length > 0) {
        requestParams.tools = tools;
      }
      const result = await this.provider.chat(requestParams);

      return {
        content: result.content,
        usage: result.usage,
        finishReason: result.finishReason || result.stopReason,
        toolCalls: result.toolCalls || null
      };
    } catch (primaryError) {
      console.error(`❌ 主 LLM 请求失败: ${primaryError.message}`);

      // 尝试 fallback provider
      if (this.fallbackProvider) {
        console.log(`🔄 尝试 Fallback LLM...`);
        try {
          const fbParams = { messages, system };
          if (tools && tools.length > 0) fbParams.tools = tools;
          const fallbackResult = await this.fallbackProvider.chat(fbParams);

          console.log(`✅ Fallback LLM 响应成功`);
          return {
            content: fallbackResult.content,
            usage: fallbackResult.usage,
            finishReason: fallbackResult.finishReason || fallbackResult.stopReason,
            toolCalls: fallbackResult.toolCalls || null
          };
        } catch (fallbackError) {
          console.error(`❌ Fallback LLM 也失败: ${fallbackError.message}`);
          throw fallbackError;
        }
      }

      throw primaryError;
    }
  }

  /**
   * 发送消息（包含历史）
   */
  async sendMessage(userMessage, options = {}) {
    const {
      system = '',
      temperature,
      maxTokens
    } = options;

    // 添加到历史
    this.addToHistory('user', userMessage);

    // 构建消息
    const messages = [...this.conversationHistory];
    
    const result = await this.chat({
      messages,
      system,
      temperature,
      maxTokens
    });

    // 添加助手回复到历史
    this.addToHistory('assistant', result.content);

    return result;
  }

  /**
   * 添加到对话历史
   */
  addToHistory(role, content) {
    this.conversationHistory.push({ role, content });
    
    // 限制历史长度
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryLength);
    }
  }

  /**
   * 清空历史
   */
  clearHistory() {
    this.conversationHistory = [];
  }

  /**
   * 获取历史
   */
  getHistory() {
    return [...this.conversationHistory];
  }

  /**
   * 模拟响应（当没有配置LLM时）
   */
  async mockChat(params) {
    const { messages, system } = params;
    const lastMessage = messages[messages.length - 1]?.content || '';

    this.framework.log('🤖 使用模拟模式（无LLM配置）');

    // 简单的模拟响应
    let response = '';
    
    if (lastMessage.includes('任务') || lastMessage.includes('todo')) {
      response = `好的，我理解你需要管理任务。\n\n当前我已经准备好了任务管理功能。\n\n你可以：\n1. 创建新任务\n2. 查看当前任务列表\n3. 更新任务状态\n\n需要我帮你做什么？`;
    } else if (lastMessage.includes('帮助') || lastMessage.includes('help')) {
      response = `我是你的任务管理助手。\n\n我可以帮助你：\n- 创建和管理任务\n- 追踪任务进度\n- 设置任务优先级\n- 管理任务依赖\n\n有什么我可以帮你的吗？`;
    } else {
      response = `我收到了你的消息：${lastMessage}\n\n作为任务管理助手，我可以帮你组织和管理工作。\n\n请告诉我你需要完成什么任务？`;
    }

    return {
      content: response,
      usage: {
        promptTokens: lastMessage.length,
        completionTokens: response.length,
        totalTokens: lastMessage.length + response.length
      },
      finishReason: 'stop'
    };
  }

  /**
   * 流式聊天
   */
  async chatStream(params) {
    if (!this.provider) {
      throw new Error('流式模式需要配置LLM');
    }

    return await this.provider.chatStream(params);
  }

  /**
   * 获取模型信息
   */
  getModelInfo() {
    if (!this.provider) {
      return {
        provider: 'mock',
        model: 'none',
        capabilities: []
      };
    }

    return this.provider.getModelInfo();
  }

  /**
   * 是否有有效LLM（含 fallback）
   */
  hasProvider() {
    return this.provider !== null || this.fallbackProvider !== null;
  }
}

module.exports = LLMManager;
