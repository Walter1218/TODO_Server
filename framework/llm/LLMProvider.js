/**
 * LLM Provider Base Interface
 * 
 * 定义LLM提供者的统一接口
 */

class LLMProvider {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * 发送聊天请求
   * @param {Object} params
   * @param {Array} params.messages - 消息列表
   * @param {string} [params.system] - 系统提示词
   * @param {number} [params.temperature] - 温度参数
   * @param {number} [params.maxTokens] - 最大token数
   * @returns {Promise<Object>} 返回响应
   */
  async chat(params) {
    throw new Error('chat() method must be implemented by subclass');
  }

  /**
   * 流式聊天
   * @param {Object} params
   * @param {Array} params.messages - 消息列表
   * @param {Function} params.onChunk - 接收每个chunk的回调
   * @returns {Promise<Object>} 返回最终响应
   */
  async chatStream(params) {
    throw new Error('chatStream() method must be implemented by subclass');
  }

  /**
   * 补全文本
   * @param {Object} params
   * @param {string} params.prompt - 提示词
   * @param {number} [params.temperature] - 温度参数
   * @param {number} [params.maxTokens] - 最大token数
   * @returns {Promise<Object>} 返回响应
   */
  async complete(params) {
    throw new Error('complete() method must be implemented by subclass');
  }

  /**
   * 获取模型信息
   * @returns {Object} 模型信息
   */
  getModelInfo() {
    throw new Error('getModelInfo() method must be implemented by subclass');
  }
}

module.exports = LLMProvider;
