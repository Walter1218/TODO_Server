/**
 * Ollama LLM Provider
 *
 * 支持本地 Ollama 模型，作为 MiniMax 等云服务的 fallback
 * API 兼容 OpenAI 格式: http://localhost:11434/v1
 */

const LLMProvider = require('./LLMProvider');

class OllamaProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.baseUrl = config.baseUrl || 'http://localhost:11434/v1';
    this.defaultModel = config.model || 'Qwen3.5_9b_f16:latest';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens || 2000;
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

    const chatMessages = [];

    if (system) {
      chatMessages.push({ role: 'system', content: system });
    }

    chatMessages.push(...messages);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: chatMessages,
          temperature,
          max_tokens: maxTokens,
          stream
        })
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Ollama API Error: ${error.error?.message || response.statusText}`);
      }

      if (stream) {
        return response;
      }

      const data = await response.json();

      return {
        content: data.choices?.[0]?.message?.content || '',
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0
        },
        model: data.model,
        finishReason: data.choices?.[0]?.finish_reason
      };
    } catch (error) {
      if (error.message.includes('Ollama API Error')) {
        throw error;
      }
      throw new Error(`Ollama request failed: ${error.message}`);
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
            if (data === '[DONE]') return;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
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
      provider: 'ollama',
      model: this.defaultModel,
      capabilities: ['chat', 'complete', 'stream'],
      features: ['local', 'offline']
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
        id: 'Qwen3.5_9b_f16:latest',
        name: 'Qwen 3.5 9B (F16)',
        description: '轻量级本地模型，适合快速 fallback',
        maxTokens: 32768,
        contextWindow: 32768
      },
      {
        id: 'gabegoodhart/minimax-m2.1:latest',
        name: 'MiniMax-M2.1 (本地)',
        description: '本地部署的 MiniMax-M2.1 模型',
        maxTokens: 32768,
        contextWindow: 32768
      }
    ];
  }
}

module.exports = OllamaProvider;
