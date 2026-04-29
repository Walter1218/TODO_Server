# 配置指南

TODO Server 使用三层配置体系：
1. **`.env`** — 服务器运行时环境变量
2. **`config.json`** — 框架客户端配置（LLM、功能开关）
3. **`agents.yaml`** — Hermes Skill 凭证映射（多智能体协作）

---

## 🌍 环境变量（`.env`）

服务器启动时自动读取 `.env` 文件。

```bash
PORT=3000              # 服务端口
DB_PATH=./data/todo.db # SQLite 数据库路径
LOG_LEVEL=info         # 日志级别：debug | info | warn | error
NODE_ENV=development   # 运行环境：development | production
```

### 生成方式

```bash
npm run setup
# 自动生成 .env 和 .env.example
```

### 手动创建

```bash
cat > .env << 'EOF'
PORT=3000
DB_PATH=./data/todo.db
LOG_LEVEL=info
NODE_ENV=development
EOF
```

---

## ⚙️ 框架客户端配置（`config.json`）

仅在使用内置框架客户端（`npm run agent`）时需要。

### 快速配置

```bash
npm run setup
# 自动生成 config.json（含随机 agent_id）
# 然后编辑填入 LLM API Key
```

### 完整配置说明

```json
{
  "server": {
    "url": "http://localhost:3000"
  },
  "llm": {
    "provider": "minimax",
    "minimax": {
      "apiKey": "",
      "groupId": "",
      "model": "MiniMax-Text-01",
      "temperature": 0.7,
      "maxTokens": 2000
    },
    "openai": {
      "apiKey": "",
      "model": "gpt-3.5-turbo",
      "temperature": 0.7,
      "maxTokens": 2000
    },
    "anthropic": {
      "apiKey": "",
      "model": "claude-3-5-haiku-20241022",
      "temperature": 0.7,
      "maxTokens": 1024
    }
  },
  "agent": {
    "id": "my-agent",
    "name": "我的智能体"
  },
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

### 配置项详解

#### `server`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | string | `http://localhost:3000` | TODO Server 地址 |

#### `llm`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | string | `minimax` | 提供者：`minimax` / `openai` / `anthropic` |
| `{provider}.apiKey` | string | `''` | API 密钥 |
| `{provider}.groupId` | string | `''` | Group ID（仅 MiniMax） |
| `{provider}.model` | string | - | 模型名称 |
| `{provider}.temperature` | number | `0.7` | 温度参数 (0-1) |
| `{provider}.maxTokens` | number | `2000` | 最大输出 token 数 |

#### `agent`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `id` | string | 随机 UUID | 智能体唯一标识 |
| `name` | string | `'我的智能体'` | 智能体名称 |

#### `features.taskManagement`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 |
| `autoCreateTasks` | boolean | `false` | 自动从对话发现任务 |
| `autoUpdateStatus` | boolean | `false` | 自动更新任务状态 |
| `priority` | string | `'medium'` | 默认优先级 |

#### `features.contextManagement`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 |
| `injectInterval` | string | `'every_turn'` | 注入频率：`every_turn` / `on_demand` / `manual` |
| `maxContextLength` | number | `2000` | 最大上下文长度 |
| `prioritizeBy` | string | `'priority'` | 排序方式 |

#### `features.memoryManagement`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用 |
| `memoryRetention` | number | `7` | 记忆保留天数 |

#### `features.promptManagement`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 |
| `autoEnhance` | boolean | `true` | 自动增强 Prompt |
| `addChecklist` | boolean | `true` | 添加检查清单 |
| `addProgress` | boolean | `true` | 添加进度信息 |

#### `features.proactiveInteraction`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 |
| `remindInterval` | number | `5` | 提醒间隔（分钟） |
| `suggestOnIdle` | boolean | `true` | 空闲时建议 |

#### `features.dependencyManagement`

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用 |
| `showBlockers` | boolean | `true` | 显示阻塞原因 |

---

## 🔑 Hermes Skill 凭证映射（`agents.yaml`）

位于 `~/.hermes/skills/hermes-todo-skill/agents.yaml`，用于将 Hermes profile 映射到 TODO Server 的 agent 凭证。

```yaml
agents:
  default:
    agent_id: cdb415c7-8d28-4511-a381-5cdaf40d936c
    secret_key: 7657682F3D7257556AB7D2633DAB54DB
    name: hermes-default
  ops:
    agent_id: 4b5ad916-435f-4292-be5c-8ec049e4faaa
    secret_key: 99E4D0FB57D6CC9964D0CE9635BF8601
    name: hermes-ops
  coder:
    agent_id: c24d64d7-5271-4860-a19f-f56b6d574ac5
    secret_key: DB3BD7A037C790340F1BA7EDC0C9D9A9
    name: hermes-coder
```

**工作原理**：
- Skill 读取 `HERMES_HOME` 环境变量
- 从路径提取 profile 名（如 `/profiles/ops` → `ops`）
- 在 `agents.yaml` 中查找对应凭证
- 自动设置 `agent_id` 和 `secret_key`

---

## 💡 使用方式

### 方式 1：使用启动器（推荐）

```bash
npm run agent
```

### 方式 2：自定义启动

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

### 方式 3：覆盖配置

```javascript
const framework = AgentTaskFramework.fromConfig(null, {
  features: {
    taskManagement: { enabled: true }
  }
});
```

---

## 🔧 配置验证

```javascript
const { ConfigLoader } = require('./framework');

const config = ConfigLoader.load();
const validation = ConfigLoader.validate(config);

if (!validation.valid) {
  console.log('配置错误：');
  validation.errors.forEach(err => console.log(`  - ${err}`));
}
```

---

## ⚠️ 安全注意事项

1. **不要将含真实 API Key 的 `config.json` 提交到版本控制**
   - `config.json` 已加入 `.gitignore`
   - `config.example.json` 可作为模板提交

2. **保护好 `agents.yaml` 中的 `secret_key`**
   - 文件权限建议设置为 `600`
   - 不要共享或提交到公共仓库

3. **生产环境**
   - 使用 `NODE_ENV=production`
   - 设置强密码级别的 `secret_key`
   - 考虑使用反向代理（Nginx）+ HTTPS

---

## 🎯 推荐配置

### 开发环境

```json
{
  "features": {
    "taskManagement": { "enabled": true },
    "contextManagement": { "enabled": true },
    "memoryManagement": { "enabled": false },
    "promptManagement": { "enabled": true, "addChecklist": true },
    "proactiveInteraction": { "enabled": true },
    "dependencyManagement": { "enabled": true }
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
    "memoryManagement": { "enabled": true, "autoSummarize": true },
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
