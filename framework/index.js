/**
 * Agent Task Framework - 入口文件
 * 
 * 提供统一的导入接口
 */

const AgentTaskFramework = require('./core/Framework');
const ConfigLoader = require('./utils/ConfigLoader');
const TaskManager = require('./modules/TaskManager');
const ContextManager = require('./modules/ContextManager');
const MemoryManager = require('./modules/MemoryManager');
const PromptManager = require('./modules/PromptManager');
const ProactiveManager = require('./modules/ProactiveManager');
const { LLMFactory, OpenAIProvider, AnthropicProvider, MiniMaxProvider } = require('./llm');

// 导出
module.exports = {
  AgentTaskFramework,
  ConfigLoader,
  TaskManager,
  ContextManager,
  MemoryManager,
  PromptManager,
  ProactiveManager,
  LLMFactory,
  OpenAIProvider,
  AnthropicProvider,
  MiniMaxProvider
};

// 便捷方法：从配置文件创建框架
AgentTaskFramework.fromConfig = function(configPath = null, overrides = {}) {
  const frameworkConfig = ConfigLoader.loadFrameworkConfig(configPath);
  
  // 合并覆盖配置
  const mergedConfig = ConfigLoader.deepMerge(frameworkConfig, overrides);
  
  return new AgentTaskFramework(mergedConfig);
};

// 添加深度合并方法
ConfigLoader.deepMerge = function(target, source) {
  const output = { ...target };
  
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (ConfigLoader.isObject(source[key]) && ConfigLoader.isObject(target[key])) {
        output[key] = ConfigLoader.deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
  }
  
  return output;
};

ConfigLoader.isObject = function(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
};
