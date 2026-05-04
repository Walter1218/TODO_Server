/**
 * OpenAI LLM Provider
 * 
 * 支持 GPT-4, GPT-3.5-Turbo 等模型
 */

const LLMProvider = require('./LLMProvider');

class OpenAIProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.defaultModel = config.model || 'gpt-3.5-turbo';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens || 2000;

    if (!this.apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass apiKey in config.');
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

    try {
      const requestBody = {
        model,
        messages: chatMessages,
        temperature,
        max_tokens: maxTokens,
        stream
      };

      if (params.tools && params.tools.length > 0) {
        requestBody.tools = params.tools;
      }

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(`OpenAI API Error: ${error.error?.message || response.statusText}`);
      }

      if (stream) {
        return response;
      }

      const data = await response.json();
      
      return {
        content: data.choices[0]?.message?.content || '',
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0
        },
        model: data.model,
        finishReason: data.choices[0]?.finish_reason,
        toolCalls: data.choices[0]?.message?.tool_calls || null
      };
    } catch (error) {
      if (error.message.includes('OpenAI API Error')) {
        throw error;
      }
      throw new Error(`OpenAI request failed: ${error.message}`);
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

    // 将补全转换为聊天格式
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
      provider: 'openai',
      model: this.defaultModel,
      capabilities: [
        'chat',
        'complete',
        'stream',
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
}

module.exports = OpenAIProvider;
