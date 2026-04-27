# Agent TODO Framework

智能体任务聚焦框架 - 帮助AI智能体管理任务、减少上下文膨胀和任务发散问题。

## 🎯 项目概述

### 核心问题
- 智能体在长对话中上下文窗口膨胀
- 多次复杂任务后出现任务发散
- 历史信息淹没关键任务
- 重复工作和任务遗漏

### 解决方案
- 外部化任务记忆到TODO服务
- 智能任务聚焦和上下文摘要
- 任务依赖关系管理
- Prompt自动注入

## 🚀 快速开始

### 1. 配置

编辑 `config.json`：

```json
{
  "server": {
    "url": "http://localhost:3000"
  },
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "你的API Key",
      "groupId": "你的Group ID",
      "model": "MiniMax-M2.7",
      "temperature": 0.7,
      "maxTokens": 196608
    }
  },
  "agent": {
    "id": "你的Agent ID"
  }
}
```

### 2. 启动

```bash
# 简单模式
node start.js

# 对话模式
npm run agent -- --chat
```

## 📁 项目结构

```
TODO_Server/
├── src/                    # TODO Server API
│   ├── server.js          # Express服务器
│   ├── db.js             # SQLite数据库
│   ├── models/           # 数据模型
│   │   ├── Agent.js
│   │   ├── Todo.js
│   │   └── Project.js
│   └── routes/          # API路由
│       ├── agents.js
│       ├── todos.js
│       └── projects.js
├── sdk/                   # Agent SDK
│   ├── agent-todo-sdk.js
│   └── README.md
├── framework/              # 任务聚焦框架
│   ├── core/             # 核心框架
│   │   └── Framework.js
│   ├── modules/          # 功能模块
│   │   ├── TaskManager.js
│   │   ├── ContextManager.js
│   │   ├── MemoryManager.js
│   │   ├── PromptManager.js
│   │   └── ProactiveManager.js
│   ├── llm/             # LLM集成
│   │   ├── MiniMaxProvider.js
│   │   ├── OpenAIProvider.js
│   │   ├── AnthropicProvider.js
│   │   ├── LLMFactory.js
│   │   └── LLMManager.js
│   └── utils/           # 工具类
│       └── ConfigLoader.js
├── config.json             # 配置文件
├── config.example.json     # 配置示例
├── start.js              # 启动脚本
└── CONFIG_GUIDE.md       # 配置指南
```

## 🎯 核心功能

### 1. 任务管理
- 创建/更新/删除任务
- 优先级系统（critical/high/medium/low）
- 标签系统
- 上下文字段（防止遗忘）

### 2. 依赖管理
- 任务依赖关系
- 循环依赖检测
- 可执行任务筛选

### 3. 项目分组
- 多项目管理
- 颜色标记
- 任务统计

### 4. 上下文摘要
```javascript
GET /api/agents/:id/todos/summary
// 返回：优先任务、被阻塞任务、智能建议、项目进度
```

### 5. LLM集成
支持：
- MiniMax (MiniMax-Text-01, MiniMax-M2.7)
- OpenAI (GPT-4, GPT-3.5-Turbo)
- Anthropic (Claude 3)

### 6. 功能模块
- TaskManager - 任务管理
- ContextManager - 上下文管理
- MemoryManager - 记忆管理
- PromptManager - Prompt管理
- ProactiveManager - 主动交互

## 📖 使用文档

### 配置文件

查看 [CONFIG_GUIDE.md](CONFIG_GUIDE.md)

### Framework API

```javascript
const { AgentTaskFramework } = require('./framework');

// 从配置启动
const framework = AgentTaskFramework.fromConfig();
await framework.initialize();

// 处理消息
const result = await framework.processMessage('帮我完成报告');

// 创建任务
await framework.modules.taskManager.createTask({
  title: '完成报告',
  priority: 'high',
  context: 'Q2季度交付物'
});
```

### SDK使用

```javascript
const AgentTODOSDK = require('./sdk/agent-todo-sdk');

const todo = new AgentTODOSDK(
  'http://localhost:3000',
  'agent-id'
);

// 快速添加任务
await todo.quickAdd('完成报告', { priority: 'high' });

// 获取上下文摘要
const { message } = await todo.focus();
```

## 📊 功能矩阵

| 功能 | Server API | SDK | Framework | 说明 |
|------|:---------:|:---:|:---------:|------|
| 智能体管理 | ✅ | - | - | 注册/查询/删除 |
| 任务CRUD | ✅ | ✅ | ✅ | 基础管理 |
| 优先级 | ✅ | ✅ | ✅ | 4级优先级 |
| 标签 | ✅ | ✅ | ✅ | 多标签 |
| 上下文字段 | ✅ | ✅ | ✅ | 防止遗忘 |
| 依赖关系 | ✅ | ✅ | ✅ | 任务排序 |
| 循环检测 | ✅ | ✅ | ✅ | 防止死循环 |
| 项目分组 | ✅ | ✅ | ✅ | 任务组织 |
| 上下文摘要 | ✅ | ✅ | ✅ | 智能聚焦 |
| 可执行任务 | ✅ | ✅ | ✅ | 依赖检查 |
| 智能建议 | ✅ | ✅ | ✅ | 自动推荐 |
| 记忆管理 | - | - | ✅ | 重要信息存储 |
| Prompt增强 | - | - | ✅ | 自动注入 |
| 主动提醒 | - | - | ✅ | 定期提醒 |
| 角色系统 | - | - | ✅ | developer/analyst/writer |
| 任务识别 | - | - | ✅ | 自动识别类型 |
| **LLM集成** | - | - | ✅ | **MiniMax/OpenAI/Claude（已测试） |

## 🔧 开发

### 启动TODO Server
```bash
npm start
```

### 运行Framework示例
```bash
node framework/examples/ProgressiveIntegration.js
```

### 运行LLM集成示例
```bash
node framework/examples/LLMIntegration.js
```

## 📈 版本进度

### 已完成 ✅

- [x] TODO Server 完整API
- [x] SDK客户端库
- [x] Framework核心框架
- [x] 6个功能模块
- [x] MiniMax集成（已测试通过）
- [x] OpenAI集成
- [x] Anthropic集成
- [x] 配置文件系统
- [x] 渐进式功能开关
- [x] 上下文摘要API
- [x] 任务依赖管理
- [x] 项目分组
- [x] Git版本管理

### 进行中 🔄

- [ ] 自动任务识别（分析对话提取任务）
- [ ] 可视化管理界面

### 计划中 📋

- [ ] Docker部署
- [ ] WebSocket实时推送
- [ ] 多语言SDK（Python, Go）
- [ ] 任务版本控制
- [ ] 任务评论系统

## 🎓 使用场景

### 1. 任务记录
```
用户：帮我完成季度报告
Agent：创建TODO，开始工作
```

### 2. 依赖管理
```
任务A → 任务B → 任务C
(完成A后才能开始B，完成B后才能开始C)
```

### 3. 上下文聚焦
```
Agent询问：我的优先任务是什么？
系统返回：1. 完成报告 [HIGH]
                 2. 修复Bug [CRITICAL]
```

### 4. 智能建议
```
系统提示：有2个紧急任务未完成，有1个任务被阻塞
```

## 📝 配置示例

### MiniMax (推荐)
```json
{
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "your-key",
      "model": "MiniMax-M2.7",
      "maxTokens": 196608
    }
  }
}
```

### OpenAI
```json
{
  "llm": {
    "provider": "openai",
    "openai": {
      "apiKey": "sk-...",
      "model": "gpt-3.5-turbo"
    }
  }
}
```

## 🤝 贡献

欢迎提交Issue和Pull Request！

## 📄 License

MIT
