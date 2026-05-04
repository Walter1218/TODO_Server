/**
 * MiniMax LLM Provider
 * 
 * 支持 MiniMax Text-01, MiniMax-M2 等模型
 * 
 * API文档: https://platform.minimax.io/docs/api-reference
 */

const LLMProvider = require('./LLMProvider');

class MiniMaxProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.MINIMAX_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.minimax.chat/v1';
    this.defaultModel = config.model || 'MiniMax-Text-01';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens || 2000;
    this.groupId = config.groupId || process.env.MINIMAX_GROUP_ID;

    if (!this.apiKey) {
      throw new Error('MiniMax API key is required. Set MINIMAX_API_KEY environment variable or pass apiKey in config.');
    }

    if (!this.groupId) {
      console.warn('⚠️ MINIMAX_GROUP_ID not set. Some models may not work.');
    }
  }

  /**
   * 发送聊天请求
   */
  async chat(params) {
    const {
      messages,
      system,
      temperature = this.defaultTemperature,
      maxTokens = this.defaultMaxTokens,
      model = this.defaultModel,
      stream = false
    } = params;

    // 构建消息列表
    const chatMessages = [];
    
    if (system) {
      chatMessages.push({ role: 'system', content: system });
    }
    
    chatMessages.push(...messages);

    const requestBody = {
      model,
      messages: chatMessages,
      temperature,
      max_tokens: maxTokens,
      stream
    };

    if (this.groupId) {
      requestBody.group_id = this.groupId;
    }

    if (params.tools && params.tools.length > 0) {
      requestBody.tools = params.tools;
    }

    try {
      const response = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`MiniMax API Error: ${error.base_error?.message || error.error?.message || response.statusText}`);
      }

      if (stream) {
        return response;
      }

      const data = await response.json();
      
      const content = data.choices?.[0]?.message?.content || '';
      const toolCalls = data.choices?.[0]?.message?.tool_calls || null;
      
      return {
        content: content,
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0
        },
        model: data.model,
        finishReason: data.choices?.[0]?.finish_reason,
        toolCalls
      };
    } catch (error) {
      if (error.message.includes('MiniMax API Error')) {
        throw error;
      }
      throw new Error(`MiniMax request failed: ${error.message}`);
    }
  }

  /**
   * 流式聊天
   */
  async chatStream(params) {
    const response = await this.chat({ ...params, stream: true });
    return response;
  }

  /**
   * 解析流式响应
   */
  async *parseStreamResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            
            if (data === '[DONE]') {
              return;
            }

            try {
              const parsed = JSON.parse(data);
              
              // MiniMax 流式响应格式
              const content = parsed.choices?.[0]?.messages?.[0]?.text ||
                            parsed.choices?.[0]?.delta?.content;
              
              if (content) {
                yield content;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 补全文本
   */
  async complete(params) {
    const {
      prompt,
      temperature = this.defaultTemperature,
      maxTokens = this.defaultMaxTokens,
      model = this.defaultModel
    } = params;

    const messages = [{ role: 'user', content: prompt }];
    
    const result = await this.chat({
      messages,
      temperature,
      maxTokens,
      model
    });

    return {
      content: result.content,
      usage: result.usage,
      model: result.model
    };
  }

  /**
   * 获取模型信息
   */
  getModelInfo() {
    return {
      provider: 'minimax',
      model: this.defaultModel,
      capabilities: [
        'chat',
        'complete',
        'stream'
      ],
      features: [
        'long_context',
        'function_calling'
      ]
    };
  }

  /**
   * 测试连接
   */
  async testConnection() {
    try {
      await this.chat({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10
      });
      return { success: true, message: 'Connection successful' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * 获取支持的模型列表
   */
  static getSupportedModels() {
    return [
      {
        id: 'MiniMax-Text-01',
        name: 'MiniMax Text-01',
        description: '超长上下文模型，支持100万token',
        maxTokens: 1000192,
        contextWindow: 1000192
      },
      {
        id: 'abab6.5s-chat',
        name: 'ABAB 6.5S Chat',
        description: 'Stable diffusion chatbot model',
        maxTokens: 245760,
        contextWindow: 245760
      },
      {
        id: 'abab6.5-chat',
        name: 'ABAB 6.5 Chat',
        description: 'Chat-optimized model',
        maxTokens: 245760,
        contextWindow: 245760
      },
      {
        id: 'MiniMax-M2',
        name: 'MiniMax-M2',
        description: 'Multi-modal model',
        maxTokens: 100000,
        contextWindow: 100000
      }
    ];
  }
}

module.exports = MiniMaxProvider;
