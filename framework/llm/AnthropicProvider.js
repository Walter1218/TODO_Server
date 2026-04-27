/**
 * Anthropic LLM Provider
 * 
 * 支持 Claude 3.5, Claude 3 等模型
 */

const LLMProvider = require('./LLMProvider');

class AnthropicProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
    this.defaultModel = config.model || 'claude-3-5-haiku-20241022';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens || 1024;

    if (!this.apiKey) {
      throw new Error('Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or pass apiKey in config.');
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

    // 构建消息
    const anthropicMessages = [];
    
    for (const msg of messages) {
      if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: msg.content
        });
      } else if (msg.role === 'assistant') {
        anthropicMessages.push({
          role: 'assistant',
          content: msg.content
        });
      }
    }

    const requestBody = {
      model,
      messages: anthropicMessages,
      temperature,
      max_tokens: maxTokens,
      stream
    };

    if (system) {
      requestBody.system = system;
    }

    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`Anthropic API Error: ${error.error?.message || response.statusText}`);
      }

      if (stream) {
        return response;
      }

      const data = await response.json();
      
      return {
        content: data.content?.[0]?.text || '',
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0
        },
        model: data.model,
        stopReason: data.stop_reason
      };
    } catch (error) {
      if (error.message.includes('Anthropic API Error')) {
        throw error;
      }
      throw new Error(`Anthropic request failed: ${error.message}`);
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
            
            try {
              const parsed = JSON.parse(data);
              
              if (parsed.type === 'content_block_delta') {
                if (parsed.delta?.text) {
                  yield parsed.delta.text;
                }
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

    // Anthropic 的消息格式
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
      provider: 'anthropic',
      model: this.defaultModel,
      capabilities: [
        'chat',
        'complete',
        'stream'
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
}

module.exports = AnthropicProvider;
