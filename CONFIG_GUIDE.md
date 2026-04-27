# 配置文件指南

Agent Task Framework 使用 JSON 配置文件管理所有设置。

## 📝 配置文件位置

框架会自动在以下位置查找配置文件：

1. `./config.json` (项目根目录)
2. `../config.json` (上级目录)

或者手动指定路径：
```javascript
AgentTaskFramework.fromConfig('/path/to/config.json');
```

## 🚀 快速开始

### 1. 编辑配置文件

```bash
# 复制示例配置
cp config.example.json config.json

# 编辑配置
vim config.json
```

### 2. 配置 LLM

在 `config.json` 中填入你的 API Key：

#### MiniMax（推荐）
```json
{
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "你的API Key",
      "groupId": "你的Group ID",
      "model": "MiniMax-Text-01"
    }
  }
}
```

#### OpenAI
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

#### Anthropic
```json
{
  "llm": {
    "provider": "anthropic",
    "anthropic": {
      "apiKey": "sk-ant-...",
      "model": "claude-3-5-haiku-20241022"
    }
  }
}
```

### 3. 启动智能体

```bash
# 简单模式
node start.js

# 对话模式
node start.js --chat
```

## 📋 配置项说明

### server

```json
{
  "server": {
    "url": "http://localhost:3000"
  }
}
```

- **url**: TODO Server 地址

### llm

```json
{
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "",
      "groupId": "",
      "model": "MiniMax-Text-01",
      "temperature": 0.7,
      "maxTokens": 2000
    }
  }
}
```

- **provider**: LLM 提供者 (`minimax` | `openai` | `anthropic`)
- **apiKey**: API 密钥
- **groupId**: Group ID（仅 MiniMax 需要）
- **model**: 模型名称
- **temperature**: 温度参数 (0-1)，越高越有创意
- **maxTokens**: 最大输出 token 数

### agent

```json
{
  "agent": {
    "id": "my-agent",
    "name": "我的智能体"
  }
}
```

- **id**: 智能体唯一标识
- **name**: 智能体名称

### features

```json
{
  "features": {
    "taskManagement": {
      "enabled": true,
      "autoCreateTasks": false,
      "autoUpdateStatus": false,
      "priority": "medium"
    },
    "contextManagement": {
      "enabled": true,
      "injectInterval": "every_turn",
      "maxContextLength": 2000,
      "prioritizeBy": "priority"
    },
    "memoryManagement": {
      "enabled": false,
      "memoryRetention": 7
    },
    "promptManagement": {
      "enabled": true,
      "autoEnhance": true,
      "addChecklist": true,
      "addProgress": true
    },
    "proactiveInteraction": {
      "enabled": true,
      "remindInterval": 5,
      "suggestOnIdle": true
    },
    "dependencyManagement": {
      "enabled": true,
      "showBlockers": true
    }
  }
}
```

#### taskManagement

- **enabled**: 是否启用
- **autoCreateTasks**: 自动从对话创建任务
- **autoUpdateStatus**: 自动更新任务状态
- **priority**: 默认优先级

#### contextManagement

- **enabled**: 是否启用
- **injectInterval**: 上下文注入频率
  - `every_turn`: 每轮对话
  - `on_demand`: 按需
  - `manual`: 手动
- **maxContextLength**: 最大上下文长度
- **prioritizeBy**: 优先级排序方式

#### memoryManagement

- **enabled**: 是否启用
- **memoryRetention**: 记忆保留天数

#### promptManagement

- **enabled**: 是否启用
- **autoEnhance**: 自动增强 Prompt
- **addChecklist**: 添加检查清单
- **addProgress**: 添加进度信息

#### proactiveInteraction

- **enabled**: 是否启用
- **remindInterval**: 提醒间隔
- **suggestOnIdle**: 空闲时建议

#### dependencyManagement

- **enabled**: 是否启用
- **showBlockers**: 显示阻塞原因

## 💡 使用示例

### 方式1：使用启动器（推荐）

```bash
node start.js
```

### 方式2：自定义启动

```javascript
const { AgentTaskFramework } = require('./framework');

async function main() {
  const framework = AgentTaskFramework.fromConfig();
  await framework.initialize();
  
  const result = await framework.processMessage('你好');
  console.log(result.response.message);
}

main();
```

### 方式3：覆盖配置

```javascript
const framework = AgentTaskFramework.fromConfig(null, {
  features: {
    taskManagement: { enabled: true }
  }
});
```

## 🔧 配置验证

运行配置验证：

```javascript
const { ConfigLoader } = require('./framework');

const config = ConfigLoader.load();
const validation = ConfigLoader.validate(config);

if (!validation.valid) {
  console.log('配置错误：');
  validation.errors.forEach(err => console.log(`  - ${err}`));
}
```

## 📝 生成配置

创建默认配置：

```javascript
const { ConfigLoader } = require('./framework');

const defaultConfig = ConfigLoader.createDefault();
ConfigLoader.save(defaultConfig, 'new-config.json');
```

## ⚠️ 注意事项

1. **API Key 安全**：不要将包含真实 API Key 的配置文件提交到版本控制
2. **config.json vs config.example.json**：
   - `config.json`: 实际使用的配置（可能包含敏感信息）
   - `config.example.json`: 示例配置（不含敏感信息，可提交到仓库）
3. **优先级**：`config.json` > 命令行参数 > 默认值

## 🎯 推荐配置

### 开发环境

```json
{
  "features": {
    "taskManagement": { "enabled": true },
    "contextManagement": { "enabled": true },
    "memoryManagement": { "enabled": false },
    "promptManagement": {
      "enabled": true,
      "addChecklist": true
    }
  }
}
```

### 生产环境

```json
{
  "features": {
    "taskManagement": {
      "enabled": true,
      "autoCreateTasks": true,
      "autoUpdateStatus": true
    },
    "contextManagement": { "enabled": true },
    "memoryManagement": {
      "enabled": true,
      "autoSummarize": true
    },
    "promptManagement": {
      "enabled": true,
      "autoEnhance": true,
      "addChecklist": true,
      "addProgress": true
    },
    "proactiveInteraction": { "enabled": true },
    "dependencyManagement": { "enabled": true }
  }
}
```

## 🤝 帮助

如有问题，请检查：

1. config.json 是否存在且格式正确
2. API Key 是否已填入
3. TODO Server 是否运行
