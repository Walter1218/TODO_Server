/**
 * 配置示例文件
 * 
 * 展示不同场景下的配置方案
 */

// 场景1：最小化配置（仅连接TODO服务）
const minimalConfig = {
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'agent-001'
  }
};

// 场景2：开发环境配置
const developmentConfig = {
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'agent-dev',
    enableLogging: true
  },
  features: {
    taskManagement: {
      enabled: true,
      autoCreateTasks: false,
      autoUpdateStatus: false,
      priority: 'medium'
    },
    contextManagement: {
      enabled: true,
      injectInterval: 'every_turn',
      maxContextLength: 2000,
      prioritizeBy: 'priority'
    },
    memoryManagement: {
      enabled: false
    },
    promptManagement: {
      enabled: true,
      autoEnhance: false,
      addChecklist: true,
      addProgress: false
    },
    proactiveInteraction: {
      enabled: false
    },
    dependencyManagement: {
      enabled: true,
      autoDetect: false,
      showBlockers: true
    }
  }
};

// 场景3：生产环境配置
const productionConfig = {
  base: {
    todoServerUrl: process.env.TODO_SERVER_URL || 'http://localhost:3000',
    agentId: process.env.AGENT_ID,
    enableLogging: false
  },
  features: {
    taskManagement: {
      enabled: true,
      autoCreateTasks: true,
      autoUpdateStatus: true,
      priority: 'high'
    },
    contextManagement: {
      enabled: true,
      injectInterval: 'every_turn',
      maxContextLength: 1500,
      includeCompleted: false,
      prioritizeBy: 'priority'
    },
    memoryManagement: {
      enabled: true,
      memoryTypes: ['task_history', 'key_decisions', 'important_facts'],
      memoryRetention: 14,
      autoSummarize: true
    },
    promptManagement: {
      enabled: true,
      autoEnhance: true,
      addChecklist: true,
      addProgress: true
    },
    proactiveInteraction: {
      enabled: true,
      remindInterval: 3,
      suggestOnIdle: true,
      blockOffTopic: false
    },
    dependencyManagement: {
      enabled: true,
      autoDetect: true,
      blockOnMissing: true,
      showBlockers: true
    }
  },
  llm: {
    provider: 'openai',
    model: 'gpt-4',
    apiKey: process.env.OPENAI_API_KEY,
    maxTokens: 2000
  }
};

// 场景4：对话式智能体配置
const conversationalConfig = {
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'conversational-agent',
    enableLogging: true
  },
  features: {
    taskManagement: {
      enabled: true,
      autoCreateTasks: false,
      autoUpdateStatus: true,
      priority: 'medium'
    },
    contextManagement: {
      enabled: true,
      injectInterval: 'on_demand',
      maxContextLength: 1000,
      prioritizeBy: 'recency'
    },
    memoryManagement: {
      enabled: true,
      memoryTypes: ['key_decisions'],
      memoryRetention: 7,
      autoSummarize: false
    },
    promptManagement: {
      enabled: true,
      autoEnhance: true,
      addChecklist: true,
      addProgress: true
    },
    proactiveInteraction: {
      enabled: true,
      remindInterval: 5,
      suggestOnIdle: true,
      blockOffTopic: false
    },
    dependencyManagement: {
      enabled: true,
      autoDetect: false,
      showBlockers: true
    }
  }
};

// 场景5：自动化任务执行配置
const automationConfig = {
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'automation-agent',
    enableLogging: true
  },
  features: {
    taskManagement: {
      enabled: true,
      autoCreateTasks: true,
      autoUpdateStatus: true,
      priority: 'critical'
    },
    contextManagement: {
      enabled: true,
      injectInterval: 'every_turn',
      maxContextLength: 3000,
      prioritizeBy: 'dependency'
    },
    memoryManagement: {
      enabled: true,
      memoryTypes: ['task_history'],
      memoryRetention: 30,
      autoSummarize: true
    },
    promptManagement: {
      enabled: true,
      autoEnhance: true,
      addChecklist: true,
      addProgress: true
    },
    proactiveInteraction: {
      enabled: true,
      remindInterval: 1,
      suggestOnIdle: false,
      blockOffTopic: true
    },
    dependencyManagement: {
      enabled: true,
      autoDetect: true,
      blockOnMissing: true,
      showBlockers: true
    }
  }
};

module.exports = {
  minimalConfig,
  developmentConfig,
  productionConfig,
  conversationalConfig,
  automationConfig
};
