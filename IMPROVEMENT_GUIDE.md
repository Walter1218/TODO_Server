# 项目改进建议指南

> 基于 2026-05-01 对项目代码的全面审查，按优先级排列的改进建议。

---

## P0 - 紧急修复（影响正确性/安全性）

### 1. 认证中间件：timing-safe 比较 + 缓存

**现状**：[server.js](src/server.js) 中 `requireAgentAuth` 每次请求直接查库，且 `===` 比较 secret_key 存在 timing attack 风险。

```js
// 当前实现（不安全）
if (!agent || agent.secret_key !== secretKey) {
  return res.status(401).json({...});
}
```

**改进建议**：
- 使用 `crypto.timingSafeEqual()` 替代 `===` 进行字符串比较
- 引入 LRU Cache（如 `lru-cache`）缓存 `agent_id -> secret_key` 映射，TTL 5min
- 敏感操作（task/transfer/assign）额外校验 `X-Agent-Secret` header 中的 agent ID 与操作者一致

### 2. MemoryManager 内存存储脆弱性

**现状**：[MemoryManager.js](framework/modules/MemoryManager.js) 依赖 `localStorage`（Node.js 环境不存在），`saveToStorage()` 和 `loadFromStorage()` 实际为空操作，重启即丢失所有记忆。

```js
// 当前实现（无法持久化）
saveToStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('agent_memory', JSON.stringify(this.memoryStore));
    }
  } catch (error) { ... }
}
```

**改进建议**：
- 替换为基于 SQLite 或文件系统的持久化（项目已有 SQLite）
- 或引入 `node-persist` / `lowdb` 等轻量级本地存储
- 添加数据恢复机制（启动时从持久层加载）

### 3. 输入验证缺失

**现状**：路由层缺乏系统性的输入验证，多个路由未校验必填字段和字段格式。

**改进建议**：
- 引入 `joi` 或 `zod` 作为统一的请求体验证库
- 为每个路由定义 schema，校验 `title`, `priority`, `status` 枚举值
- 限制 `tags`, `dependencies` 数组最大长度防止 DoS
- 验证 `expectedDurationMinutes` 为正整数

---

## P1 - 高优先级（影响性能/可维护性）

### 4. Framework.js 单体职责过重

**现状**：[Framework.js](framework/core/Framework.js) 承担了模块管理、LLM调用、消息处理、事件总线、熔断器、定时器等多个职责（~800行）。

**改进建议**：
- 抽取 CircuitBreaker 为独立模块 `framework/utils/CircuitBreaker.js`
- 抽取 EventBus 为独立模块 `framework/core/EventBus.js`
- 抽取消息路由为独立模块 `framework/core/MessageRouter.js`
- Framework 仅保留模块初始化和生命周期管理

### 5. ConfigLoader 脆弱的配置搜索

**现状**：[ConfigLoader.js](framework/utils/ConfigLoader.js) 通过多路径拼接搜索 `config.json`，依赖 `require.main.filename`，在测试/被其他工具调用时可能找不到配置。

**改进建议**：
- 支持环境变量 `CONFIG_PATH` 显式指定配置路径
- 支持 `--config` CLI 参数
- 配置加载失败时提供明确的错误信息和修复建议
- 添加配置文件格式校验（JSON Schema）

### 6. 缺少速率限制

**现状**：所有 API 端点无速率限制，恶意客户端可轻易压垮服务。

**改进建议**：
- 引入 `express-rate-limit` 中间件
- 按 agent 区分限流：全局 100 req/min，LLM 相关端点 10 req/min
- 对 `POST /` 创建任务接口实施更严格限制（防 LLM 循环创建）

---

## P2 - 中优先级（影响质量/工程规范）

### 7. 数据库迁移策略需优化

**现状**：[db.js](src/db.js) 使用逐个 `try/catch ALTER TABLE` 方式做迁移，无法回滚，无法追踪迁移历史。

**改进建议**：
- 引入轻量级迁移工具（如 `knex.migrate` 或自建迁移表）
- 记录已执行的迁移版本到 `migrations` 表
- 提供 `npm run migrate` 和 `npm run migrate:rollback` 命令
- 添加迁移测试（验证旧数据兼容性）

### 8. 缺乏 API 文档

**现状**：README 中的 API 表格仅列出路由名，缺少请求/响应示例、参数说明。

**改进建议**：
- 引入 `swagger-jsdoc` + `swagger-ui-express` 自动生成 OpenAPI 文档
- 或维护独立的 `API.md` 文件，包含每个端点的完整请求/响应示例
- 添加 curl 示例用于快速测试

### 9. 错误处理不一致

**现状**：路由层的错误处理混用 `try/catch` + `next(e)` 和直接 `res.status().json()`，部分路由遗漏错误处理。

**改进建议**：
- 定义统一的 AppError 类（含 statusCode, code, message）
- 添加全局错误处理中间件
- 错误响应格式标准化：`{ success: false, error: { code, message, details } }`
- LLM 调用超时/熔断时返回结构化的降级响应

### 10. 测试覆盖率待提升

**现状**：已添加 98 个核心单元测试，但以下区域仍需覆盖：

| 未覆盖区域 | 建议 |
|-----------|------|
| Express 路由层 | 添加 `supertest` 集成测试 |
| LLMManager / MockChat | 添加 Provider 切换、超时、fallback 测试 |
| agent-worker.js | 添加 Agent 循环执行逻辑测试 |
| SDK (agent-todo-sdk.js) | 添加 SDK 方法的 mock HTTP 测试 |
| ProactiveManager | 添加提醒逻辑测试 |
| 并发场景 | 添加数据库并发写入测试 |

```bash
# 安装 supertest
npm install --save-dev supertest

# 查看覆盖率报告
npm run test:coverage
```

---

## P3 - 低优先级（代码质量/最佳实践）

### 11. 重复代码抽取

- `todos.js` 路由中 `parseTodoFields()` 重复 3 次（GET、PUT、搜索结果）
- `MemoryManager.js` 的 `storeMemory` 与 `extractAndStore` 中的 memory 构建逻辑重复
- 建议抽取为共享工具函数

### 12. 日志系统

- 当前使用 `console.log` 无级别区分
- 建议引入 `winston` 或 `pino`，支持日志级别（debug/info/warn/error）
- 添加请求日志中间件（morgan）

### 13. TypeScript 迁移

- 当前全量 JavaScript，无类型检查
- 优先对 Model 层和 SDK 添加 TypeScript 类型定义（`.d.ts`）
- 长期可考虑全量迁移

### 14. CI/CD 集成

- 添加 GitHub Actions 工作流：
  - PR 触发：`npm test` + lint
  - main 分支：部署到 staging
  - tag 触发：部署到 production

---

## 改进路线图

```
Phase 1 (本周): P0 项目 #1 timing-safe + 缓存, #3 输入验证
Phase 2 (下周): P1 项目 #4 Framework 拆分, #6 速率限制
Phase 3 (两周内): P2 项目 #7 迁移优化, #8 API 文档
Phase 4 (持续): P3 所有项目 + 测试覆盖率提升
```
