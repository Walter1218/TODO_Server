/**
 * LLM Factory
 * 
 * LLM提供者工厂，根据配置创建相应的LLM实例
 */

const OpenAIProvider = require('./OpenAIProvider');
const AnthropicProvider = require('./AnthropicProvider');
const MiniMaxProvider = require('./MiniMaxProvider');
const OllamaProvider = require('./OllamaProvider');

class LLMFactory {
  /**
   * 创建LLM实例
   * @param {string} provider - 提供者名称：'openai' | 'anthropic' | 'minimax'
   * @param {Object} config - 配置
   * @returns {LLMProvider} LLM提供者实例
   */
  static create(provider, config = {}) {
    switch (provider.toLowerCase()) {
      case 'openai':
        return new OpenAIProvider(config);

      case 'anthropic':
        return new AnthropicProvider(config);

      case 'minimax':
        return new MiniMaxProvider(config);

      case 'ollama':
        return new OllamaProvider(config);

      default:
        throw new Error(`Unknown LLM provider: ${provider}. Supported providers: openai, anthropic, minimax, ollama`);
    }
  }

  /**
   * 从配置对象创建
   * @param {Object} llmConfig - LLM配置 { provider, apiKey, model, ... }
   * @returns {LLMProvider} LLM提供者实例
   */
  static createFromConfig(llmConfig) {
    if (!llmConfig || !llmConfig.provider) {
      throw new Error('LLM config must include provider field');
    }

    return this.create(llmConfig.provider, llmConfig);
  }

  /**
   * 获取支持的提供者列表
   */
  static getSupportedProviders() {
    return ['openai', 'anthropic', 'minimax', 'ollama'];
  }

  /**
   * 获取默认配置
   */
  static getDefaultConfig(provider) {
    switch (provider.toLowerCase()) {
      case 'openai':
        return {
          provider: 'openai',
          model: 'gpt-3.5-turbo',
          temperature: 0.7,
          maxTokens: 2000
        };

      case 'anthropic':
        return {
          provider: 'anthropic',
          model: 'claude-3-5-haiku-20241022',
          temperature: 0.7,
          maxTokens: 1024
        };

      case 'minimax':
        return {
          provider: 'minimax',
          model: 'MiniMax-Text-01',
          temperature: 0.7,
          maxTokens: 2000
        };

      case 'ollama':
        return {
          provider: 'ollama',
          model: 'Qwen3.5_9b_f16:latest',
          baseUrl: 'http://localhost:11434/v1',
          temperature: 0.7,
          maxTokens: 2000
        };

      default:
        return null;
    }
  }
}

module.exports = LLMFactory;
