# LLM 集成

Agent Task Framework 的 LLM 集成模块，支持 OpenAI GPT、Anthropic Claude 和 MiniMax。

## 🎯 概述

框架内置统一的 LLM 接口，可以轻松切换不同的 LLM 提供者：

- **OpenAI** (GPT-4, GPT-3.5-Turbo)
- **Anthropic** (Claude 3.5, Claude 3)
- **MiniMax** (MiniMax-Text-01, abab6.5s)

## 🚀 快速开始

### 1. 配置 MiniMax（推荐）

```javascript
const framework = new AgentTaskFramework({
  base: {
    todoServerUrl: 'http://localhost:3000',
    agentId: 'my-agent'
  },
  llm: {
    provider: 'minimax',
    apiKey: process.env.MINIMAX_API_KEY,
    groupId: process.env.MINIMAX_GROUP_ID,
    model: 'MiniMax-Text-01',  // 或 'abab6.5s-chat'
    temperature: 0.7,
    maxTokens: 2000
  }
});

await framework.initialize();
```

### 2. 配置 OpenAI

```javascript
const framework = new AgentTaskFramework({
  base: { ... },
  llm: {
    provider: 'openai',
    apiKey: 'sk-...',  // 或设置环境变量 OPENAI_API_KEY
    model: 'gpt-3.5-turbo',  // 或 'gpt-4'
    temperature: 0.7,
    maxTokens: 2000
  }
});
```

### 3. 配置 Anthropic (Claude)

```javascript
const framework = new AgentTaskFramework({
  llm: {
    provider: 'anthropic',
    apiKey: 'sk-ant-...',  // 或设置环境变量 ANTHROPIC_API_KEY
    model: 'claude-3-5-haiku-20241022',
    temperature: 0.7,
    maxTokens: 1024
  }
});
```

### 4. 使用环境变量

```bash
# MiniMax（推荐）
export MINIMAX_API_KEY=your-api-key
export MINIMAX_GROUP_ID=your-group-id

# OpenAI
export OPENAI_API_KEY=sk-your-key

# Anthropic
export ANTHROPIC_API_KEY=sk-ant-your-key
```

## 📚 MiniMax 模型

| 模型 | 说明 | 特点 |
|------|------|------|
| **MiniMax-Text-01** | 超长上下文模型 | 支持100万token，适合长文档处理 |
| **abab6.5s-chat** | 稳定对话模型 | 性能稳定，适合日常对话 |
| **abab6.5-chat** | 通用对话模型 | 能力均衡 |
| **MiniMax-M2** | 多模态模型 | 支持多种模态 |

## 🤖 MiniMax 配置示例

```javascript
// 基础配置
const framework = new AgentTaskFramework({
  llm: {
    provider: 'minimax',
    apiKey: 'eyJ...',      // MiniMax API Key
    groupId: '123456789',  // Group ID
    model: 'MiniMax-Text-01'
  }
});

// 长上下文任务
const framework = new AgentTaskFramework({
  llm: {
    provider: 'minimax',
    apiKey: process.env.MINIMAX_API_KEY,
    groupId: process.env.MINIMAX_GROUP_ID,
    model: 'MiniMax-Text-01',
    maxTokens: 50000  // 支持更大的输出
  },
  features: {
    taskManagement: { enabled: true },
    contextManagement: { enabled: true }
  }
});
```

### 获取 MiniMax API Key

1. 访问 MiniMax 开放平台：https://platform.minimax.io/
2. 注册/登录账户
3. 进入控制台 → API Keys
4. 创建新的 API Key
5. 复制 API Key 和 Group ID

## 📊 配置选项

```javascript
const config = {
  llm: {
    provider: 'minimax',      // 'openai' | 'anthropic' | 'minimax'
    apiKey: null,             // API密钥，默认从环境变量读取
    groupId: null,            // MiniMax Group ID
    model: 'MiniMax-Text-01', // 模型名称
    temperature: 0.7,        // 温度参数 0-1
    maxTokens: 2000          // 最大token数
  }
}
```

## 💡 使用示例

### 基本对话

```javascript
const framework = new AgentTaskFramework({
  base: { ... },
  llm: {
    provider: 'minimax',
    apiKey: process.env.MINIMAX_API_KEY,
    groupId: process.env.MINIMAX_GROUP_ID
  },
  features: {
    taskManagement: { enabled: true }
  }
});

await framework.initialize();

// 处理用户消息
const result = await framework.processMessage('帮我完成项目报告');
console.log(result.response.message);
```

### 带任务的对话

```javascript
// 先创建任务
const taskManager = framework.modules.taskManager;
await taskManager.createTask({
  title: '完成用户调研报告',
  priority: 'high',
  context: '这是Q2季度的核心交付物'
});

// 然后询问
const result = await framework.processMessage('我现在应该先做什么？');
console.log(result.response.message);
```

## 🔧 MiniMax 特定功能

### 超长上下文

MiniMax-Text-01 支持100万token的上下文，适合处理长文档：

```javascript
const framework = new AgentTaskFramework({
  llm: {
    provider: 'minimax',
    model: 'MiniMax-Text-01',
    maxTokens: 500000  // 50万token输出
  }
});
```

### 流式响应

```javascript
const llmManager = framework.getLLMManager();
const provider = llmManager.provider;

const streamResponse = await provider.chatStream({
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true
});

for await (const chunk of provider.parseStreamResponse(streamResponse)) {
  process.stdout.write(chunk);
}
```

## 📂 文件结构

```
framework/
└── llm/
    ├── index.js              # 入口
    ├── LLMProvider.js        # 基类
    ├── OpenAIProvider.js     # OpenAI实现
    ├── AnthropicProvider.js  # Anthropic实现
    ├── MiniMaxProvider.js    # MiniMax实现 ⭐
    ├── LLMFactory.js        # 工厂类
    └── LLMManager.js        # 管理器
```

## 🚀 运行示例

```bash
# 设置环境变量
export MINIMAX_API_KEY=your-api-key
export MINIMAX_GROUP_ID=your-group-id

# 运行MiniMax示例
cd framework
node examples/MiniMaxExample.js
```

## ⚠️ 常见问题

### 1. API Key 未设置

```
Error: MiniMax API key is required
```

解决：
```bash
export MINIMAX_API_KEY=your-key
export MINIMAX_GROUP_ID=your-group-id
```

### 2. Group ID 未设置

```
⚠️ MINIMAX_GROUP_ID not set. Some models may not work.
```

解决：确保同时设置 `MINIMAX_API_KEY` 和 `MINIMAX_GROUP_ID`

### 3. 请求失败

检查：
- API Key 是否正确
- Group ID 是否正确
- 网络连接是否正常
- 账户余额是否充足

## 🎓 高级用法

### 切换提供者

```javascript
// 动态切换
framework.config.llm.provider = 'minimax';
framework.config.llm.apiKey = 'new-key';
framework.config.llm.groupId = 'new-group-id';
await framework.modules.llmManager.initialize();
```

### 自定义请求

```javascript
const llmManager = framework.getLLMManager();
const provider = llmManager.provider;

// 直接使用
const result = await provider.chat({
  messages: [{ role: 'user', content: 'Hello' }]
});
```

## 📈 性能对比

| 提供者 | 模型 | 上下文长度 | 成本 | 速度 |
|--------|------|----------|------|------|
| **MiniMax** | MiniMax-Text-01 | 100万token | 中 | 快 |
| **OpenAI** | GPT-4 | 128k | 高 | 中 |
| **OpenAI** | GPT-3.5 | 16k | 低 | 快 |
| **Anthropic** | Claude 3 | 200k | 高 | 中 |

## 🤝 支持

如有问题，请检查：

1. API Key 和 Group ID 是否正确
2. 网络连接是否正常
3. 账户额度是否充足
4. 模型名称是否正确
