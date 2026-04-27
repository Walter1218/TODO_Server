# Agent Task Framework

智能体任务聚焦框架 - 一步到位的架构，逐步开放的功能

## 🎯 设计理念

### 框架 vs 功能

```
┌─────────────────────────────────────────┐
│         Agent Task Framework            │
│                                         │
│  框架架构（一步到位）                    │
│  ├── 配置系统                            │
│  ├── 核心引擎                            │
│  ├── 模块加载器                          │
│  └── 生命周期管理                        │
│                                         │
│  功能模块（按需启用）                    │
│  ├── Phase 1: 任务管理                   │
│  ├── Phase 2: 上下文管理                 │
│  ├── Phase 3: 记忆管理                   │
│  ├── Phase 4: Prompt管理                 │
│  ├── Phase 5: 主动交互                  │
│  └── Phase 6: 依赖管理                  │
│                                         │
└─────────────────────────────────────────┘
```

## 🚀 快速开始

### 1. 基础使用

```javascript
const { AgentTaskFramework } = require('./framework');

// 创建框架实例
const framework = new AgentTaskFramework({
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'my-agent'
  }
});

// 初始化
await framework.initialize();

// 处理消息
const result = await framework.processMessage('帮我完成用户调研');
```

### 2. 启用任务管理

```javascript
const framework = new AgentTaskFramework({
  base: { ... },
  features: {
    taskManagement: {
      enabled: true,
      autoCreateTasks: true,
      autoUpdateStatus: true
    }
  }
});

await framework.initialize();

// 创建任务
await framework.modules.taskManager.createTask({
  title: '完成报告',
  priority: 'high',
  context: 'Q2季度交付物'
});

// 获取上下文摘要
const summary = await framework.modules.contextManager.getSummary();
```

### 3. 完整功能

```javascript
const framework = new AgentTaskFramework({
  base: { ... },
  features: {
    taskManagement: { enabled: true },
    contextManagement: { enabled: true },
    memoryManagement: { enabled: true },
    promptManagement: { enabled: true },
    proactiveInteraction: { enabled: true },
    dependencyManagement: { enabled: true }
  }
});
```

## 📂 项目结构

```
framework/
├── index.js                      # 统一入口
├── core/
│   └── Framework.js             # 核心框架
├── modules/
│   ├── TaskManager.js          # 任务管理器
│   ├── ContextManager.js       # 上下文管理器
│   ├── MemoryManager.js        # 记忆管理器
│   ├── PromptManager.js        # Prompt管理器
│   └── ProactiveManager.js     # 主动交互管理器
├── examples/
│   ├── ProgressiveIntegration.js # 渐进式集成示例
│   └── ConfigExamples.js        # 配置示例
└── README.md
```

## ⚙️ 配置系统

### 功能开关

```javascript
const config = {
  // 基础配置
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'agent-001',
    enableLogging: true
  },

  // 功能模块
  features: {
    // Phase 1: 任务管理
    taskManagement: {
      enabled: false,           // 启用/禁用
      autoCreateTasks: false,    // 自动创建任务
      autoUpdateStatus: false,   // 自动更新状态
      priority: 'medium'         // 默认优先级
    },

    // Phase 2: 上下文管理
    contextManagement: {
      enabled: false,
      injectInterval: 'every_turn',  // every_turn | on_demand | manual
      maxContextLength: 2000,
      prioritizeBy: 'priority'        // priority | recency | dependency
    },

    // Phase 3: 记忆管理
    memoryManagement: {
      enabled: false,
      memoryTypes: ['task_history', 'key_decisions'],
      memoryRetention: 7,
      autoSummarize: false
    },

    // Phase 4: Prompt管理
    promptManagement: {
      enabled: false,
      systemPrompt: '',
      autoEnhance: false,
      addChecklist: false,
      addProgress: false
    },

    // Phase 5: 主动交互
    proactiveInteraction: {
      enabled: false,
      remindInterval: 5,
      suggestOnIdle: true,
      blockOffTopic: false
    },

    // Phase 6: 依赖管理
    dependencyManagement: {
      enabled: false,
      autoDetect: false,
      blockOnMissing: false,
      showBlockers: true
    }
  }
};
```

### 配置示例

查看 `examples/ConfigExamples.js` 获取不同场景的配置：

- **minimalConfig** - 最小配置
- **developmentConfig** - 开发环境
- **productionConfig** - 生产环境
- **conversationalConfig** - 对话式智能体
- **automationConfig** - 自动化任务执行

## 🎓 渐进式集成路线

### 阶段1：连接（1小时）

仅连接TODO服务，准备就绪：

```javascript
const framework = new AgentTaskFramework({
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'agent-001'
  }
});

await framework.initialize();
// 框架已就绪，可以开始对话
```

### 阶段2：任务管理（1天）

启用任务管理功能：

```javascript
features: {
  taskManagement: {
    enabled: true,
    autoCreateTasks: false,  // 先手动测试
    autoUpdateStatus: false
  }
}
```

### 阶段3：上下文注入（1天）

自动注入任务上下文：

```javascript
features: {
  taskManagement: { enabled: true },
  contextManagement: {
    enabled: true,
    injectInterval: 'every_turn'
  }
}
```

### 阶段4：记忆管理（1天）

自动记忆重要信息：

```javascript
features: {
  // ... 前面的功能
  memoryManagement: {
    enabled: true,
    autoSummarize: false  // 先不自动摘要
  }
}
```

### 阶段5：Prompt增强（1天）

增强系统Prompt：

```javascript
features: {
  // ... 前面的功能
  promptManagement: {
    enabled: true,
    addChecklist: true,
    addProgress: true
  }
}
```

### 阶段6：主动交互（持续）

启用主动提醒：

```javascript
features: {
  // ... 前面的功能
  proactiveInteraction: {
    enabled: true,
    remindInterval: 5,
    suggestOnIdle: true
  }
}
```

## 🔧 核心API

### AgentTaskFramework

```javascript
// 创建实例
const framework = new AgentTaskFramework(config);

// 初始化
await framework.initialize();

// 处理消息
const result = await framework.processMessage(message, history);

// 启用功能
framework.enableFeature('taskManagement');

// 禁用功能
framework.disableFeature('taskManagement');

// 获取状态
const status = framework.getStatus();
```

### TaskManager

```javascript
// 创建任务
const task = await framework.modules.taskManager.createTask({
  title: '任务标题',
  priority: 'high',
  context: '任务背景'
});

// 获取任务信息
const info = await framework.modules.taskManager.getTaskInfo();

// 完成任务
await framework.modules.taskManager.completeTask(taskId);

// 获取可执行任务
const ready = await framework.modules.taskManager.getReadyTasks();

// 规划任务链
await framework.modules.taskManager.planTaskChain([
  { title: '任务1', priority: 'high' },
  { title: '任务2', dependsOnPrevious: true }
]);
```

### ContextManager

```javascript
// 获取上下文摘要
const summary = await framework.modules.contextManager.getSummary();

// 获取格式化上下文
const formatted = framework.modules.contextManager.getFormattedContext(summary);

// 是否应该注入
const should = framework.modules.contextManager.shouldInject();
```

### MemoryManager

```javascript
// 获取最近记忆
const memory = await framework.modules.memoryManager.getRecentMemory();

// 存储记忆
await framework.modules.memoryManager.storeMemory(
  '用户选择了方案A',
  'decision',
  { importance: 'high' }
);

// 搜索记忆
const results = framework.modules.memoryManager.search('方案');
```

### PromptManager

```javascript
// 获取系统Prompt
const prompt = await framework.modules.promptManager.getSystemPrompt();

// 创建Prompt模板
framework.modules.promptManager.createPromptTemplate(
  'daily_report',
  '生成日报，格式：{{format}}'
);

// 使用模板
const output = await framework.modules.promptManager.useTemplate(
  'daily_report',
  { format: '简洁' }
);
```

### ProactiveManager

```javascript
// 检查是否需要提醒
const reminder = framework.modules.proactiveManager.shouldRemind();

// 检测是否偏离主题
const detection = framework.modules.proactiveManager.detectOffTopic(
  message,
  currentTask
);
```

## 📊 运行示例

```bash
# 运行渐进式集成示例
node examples/ProgressiveIntegration.js
```

示例输出：

```
========== 阶段1：最小化使用 ==========

框架状态: { initialized: true, activeModules: [], enabledFeatures: [] }

========== 阶段2：基础任务管理 ==========

任务1创建成功: 完成用户调研报告
任务2创建成功: 修复登录Bug

任务概览: { total: 2, pending: 2, ... }

========== 阶段3：完整功能 ==========

框架状态: { 
  initialized: true, 
  activeModules: ['taskManager', 'contextManager', ...],
  enabledFeatures: ['taskManagement', 'contextManagement', ...]
}
```

## 🎯 最佳实践

### 1. 从简单开始

```javascript
// ❌ 不要一开始就启用所有功能
const framework = new AgentTaskFramework({
  features: {
    taskManagement: { enabled: true },
    contextManagement: { enabled: true },
    memoryManagement: { enabled: true },
    // ... 全部启用
  }
});

// ✅ 逐步启用，观察效果
const framework = new AgentTaskFramework({ base: { ... } });
// 先测试基本功能
framework.enableFeature('taskManagement');
// 运行一段时间后，再启用下一个功能
```

### 2. 使用环境变量

```javascript
// productionConfig.js
const config = {
  base: {
    todoServerUrl: process.env.TODO_SERVER_URL,
    agentId: process.env.AGENT_ID
  }
};
```

### 3. 自定义Prompt

```javascript
features: {
  promptManagement: {
    enabled: true,
    systemPrompt: `
      你是一个专业的[角色]助手。
      
      你的职责：
      1. ...
      2. ...
      
      工作原则：
      - ...
      - ...
    `
  }
}
```

### 4. 监控和调试

```javascript
// 启用详细日志
const framework = new AgentTaskFramework({
  base: {
    enableLogging: true
  }
});

// 查看框架状态
console.log(framework.getStatus());

// 检查特定模块
const taskManager = framework.modules.taskManager;
const info = await taskManager.getTaskInfo();
console.log(info);
```

## 🔄 动态功能管理

```javascript
// 运行时启用功能
await framework.initialize();

// 启用任务管理
framework.enableFeature('taskManagement');

// 运行一段时间...

// 禁用不需要的功能
framework.disableFeature('proactiveInteraction');

// 查看当前状态
console.log(framework.getStatus());
```

## 📈 性能优化

### 1. 控制上下文长度

```javascript
features: {
  contextManagement: {
    maxContextLength: 1500  // 根据模型限制调整
  }
}
```

### 2. 调整提醒频率

```javascript
features: {
  proactiveInteraction: {
    remindInterval: 10  // 减少频繁提醒
  }
}
```

### 3. 限制记忆数量

```javascript
features: {
  memoryManagement: {
    memoryRetention: 3  // 减少记忆保留天数
  }
}
```

## 🐛 故障排除

### TODO服务无法连接

```javascript
// 检查URL是否正确
const framework = new AgentTaskFramework({
  base: {
    todoServerUrl: 'http://localhost:3000'  // 不要带尾部斜杠
  }
});

// 测试连接
try {
  const result = await framework.modules.taskManager.getTaskInfo();
  console.log('连接成功');
} catch (error) {
  console.error('连接失败:', error.message);
}
```

### 功能不生效

```javascript
// 检查配置
console.log(framework.config.features);

// 检查状态
console.log(framework.getStatus());

// 确认模块已加载
console.log(Object.keys(framework.modules));
```

## 🤝 贡献

欢迎提交Issue和Pull Request！

## 📄 License

MIT
