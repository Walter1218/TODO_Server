/**
 * 配置加载器
 * 
 * 从配置文件加载配置，支持 JSON 格式
 */

const fs = require('fs');
const path = require('path');

class ConfigLoader {
  /**
   * 加载配置文件
   * @param {string} configPath - 配置文件路径，默认从当前目录查找 config.json
   * @returns {Object} 配置对象
   */
  static load(configPath = null) {
    if (!configPath) {
      // 尝试多个可能的配置文件位置
      const possiblePaths = [
        'config.json',
        './config.json',
        '../config.json',
        path.join(__dirname, '..', '..', 'config.json')
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          configPath = p;
          break;
        }
      }

      if (!configPath) {
        throw new Error('配置文件不存在，请创建 config.json 文件');
      }
    }

    if (!fs.existsSync(configPath)) {
      throw new Error(`配置文件不存在: ${configPath}`);
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(content);
      
      console.log(`✅ 配置文件已加载: ${configPath}`);
      return config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`配置文件格式错误: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 加载并转换为框架配置格式
   * @param {string} configPath - 配置文件路径
   * @returns {Object} 框架配置对象
   */
  static loadFrameworkConfig(configPath = null) {
    const config = this.load(configPath);
    return this.toFrameworkConfig(config);
  }

  /**
   * 将配置文件转换为框架配置格式
   * @param {Object} config - 原始配置
   * @returns {Object} 框架配置
   */
  static toFrameworkConfig(config) {
    const frameworkConfig = {
      base: {
        todoServerUrl: config.server?.url || 'http://localhost:3000',
        agentId: config.agent?.id || 'default-agent',
        enableLogging: true
      },
      features: {},
      llm: {}
    };

    // 转换 features
    if (config.features) {
      for (const [key, value] of Object.entries(config.features)) {
        if (typeof value === 'object' && value !== null) {
          frameworkConfig.features[key] = value;
        } else if (typeof value === 'boolean') {
          frameworkConfig.features[key] = { enabled: value };
        }
      }
    }

    // 转换 LLM 配置
    if (config.llm) {
      const provider = config.llm.provider || 'minimax';
      
      // 获取对应提供者的配置
      const providerConfig = config.llm[provider] || {};
      
      frameworkConfig.llm = {
        provider: provider,
        apiKey: providerConfig.apiKey || null,
        groupId: providerConfig.groupId || null,
        model: providerConfig.model || null,
        temperature: providerConfig.temperature ?? 0.7,
        maxTokens: providerConfig.maxTokens || 2000
      };

      // 检查是否配置了 API Key
      if (!frameworkConfig.llm.apiKey) {
        console.warn(`⚠️ LLM API Key 未配置，将使用模拟模式`);
        frameworkConfig.llm.provider = null;
      }
    }

    return frameworkConfig;
  }

  /**
   * 保存配置到文件
   * @param {Object} config - 配置对象
   * @param {string} configPath - 配置文件路径
   */
  static save(config, configPath = 'config.json') {
    try {
      const content = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, content, 'utf-8');
      console.log(`✅ 配置文件已保存: ${configPath}`);
    } catch (error) {
      throw new Error(`保存配置失败: ${error.message}`);
    }
  }

  /**
   * 验证配置
   * @param {Object} config - 配置对象
   * @returns {Object} 验证结果 { valid: boolean, errors: string[] }
   */
  static validate(config) {
    const errors = [];

    // 验证 server
    if (config.server && !config.server.url) {
      errors.push('server.url 未设置');
    }

    // 验证 LLM
    if (config.llm) {
      const provider = config.llm.provider;
      
      if (!provider) {
        errors.push('llm.provider 未设置');
      } else {
        const providerConfig = config.llm[provider];
        
        if (!providerConfig) {
          errors.push(`llm.${provider} 配置不存在`);
        } else if (!providerConfig.apiKey) {
          errors.push(`llm.${provider}.apiKey 未设置`);
        }
      }
    }

    // 验证 agent
    if (config.agent && !config.agent.id) {
      errors.push('agent.id 未设置');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 创建默认配置
   * @returns {Object} 默认配置
   */
  static createDefault() {
    return {
      server: {
        url: 'http://localhost:3000'
      },
      llm: {
        provider: 'minimax',
        minimax: {
          apiKey: '',
          groupId: '',
          model: 'MiniMax-Text-01',
          temperature: 0.7,
          maxTokens: 2000
        },
        openai: {
          apiKey: '',
          model: 'gpt-3.5-turbo',
          temperature: 0.7,
          maxTokens: 2000
        },
        anthropic: {
          apiKey: '',
          model: 'claude-3-5-haiku-20241022',
          temperature: 0.7,
          maxTokens: 1024
        }
      },
      agent: {
        id: 'my-agent',
        name: '我的智能体'
      },
      features: {
        taskManagement: {
          enabled: true,
          priority: 'medium'
        },
        contextManagement: {
          enabled: true,
          injectInterval: 'every_turn'
        },
        memoryManagement: {
          enabled: false
        },
        promptManagement: {
          enabled: true,
          autoEnhance: true,
          addChecklist: true
        },
        proactiveInteraction: {
          enabled: true,
          remindInterval: 5
        },
        dependencyManagement: {
          enabled: true
        }
      }
    };
  }
}

module.exports = ConfigLoader;
