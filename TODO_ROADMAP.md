# TODO Server 路线图

> 最后更新：2026-04-29

---

## ✅ 已实现

### 基础设施
- [x] Express + SQLite (WAL 模式) + 安全迁移
- [x] Agent 认证（secret_key）+ 跨 agent 操作
- [x] `npm run setup` 一键安装向导
- [x] `.env` 环境变量支持

### 任务管理
- [x] 任务 CRUD + 子任务（parent_id）
- [x] 4 级优先级 + 标签 + 上下文字段
- [x] 依赖关系 + 循环依赖检测
- [x] 项目分组 + 颜色标记

### 聚焦与执行
- [x] **聚焦引擎**（Focus Engine）：自动评分选优
- [x] **心跳追踪**：5 分钟上报 + 30 分钟卡住检测
- [x] **重试管理**：max_attempts / attempt_count / attempt_log
- [x] **验收标准**：LLM 生成 checklist + 用户显式确认
- [x] **漂移检测**：LLM 语义分析偏离度 + 主动提醒（[A][B][C]）
- [x] **任务自动发现**：从对话提取候选任务 + 用户确认创建
- [x] **显式完成确认**：展示 checklist → 用户确认 → 标记完成

### 多智能体协作
- [x] 任务指派（assign）+ 转交（transfer）
- [x] 跨 agent 通知（assigned / transferred / completed / comment）
- [x] 我创建的任务 / 指派给我的任务查询
- [x] 项目全局看板（按 agent 分组统计）
- [x] 自动创建目标 agent（如果不存在）

### 上下文与记忆
- [x] 对话上下文存储（contexts 表）
- [x] 按 session 查询 + 摘要
- [x] 子任务切换感知（focus_change 注入）

### 稳定性
- [x] **熔断 + 本地缓存**：3 次失败降级 + 30 秒恢复探测
- [x] 熔断时退化为普通聊天模式

### SDK 与接入
- [x] JavaScript SDK（完整 CRUD + 协作 + 心跳）
- [x] Python CLI Skill（`todo_skill.py`）
- [x] Profile 感知自动匹配凭证（`agents.yaml`）
- [x] Skill 同步到所有 Hermes profile（default / ops / coder）

---

## ✅ 近期已优化（2026-04-29）

### 稳定性与可观测性
- [x] **`GET /todos` 支持 `title` 查询参数** — 服务端精确过滤，避免客户端全量加载后遍历
- [x] **`todo_report.sh` 稳定 ID 缓存** — 新增 `--task-id` 参数 + `~/.hermes/.todo_task_ids.json` 本地缓存，解决 title 变更导致汇报失效问题
- [x] **消除静默失败** — `todo_report.sh` 检查 HTTP 状态码，非 2xx 输出到 stderr；`daily_update.sh` / `daily_incremental_check.sh` 失败时携带日志末尾 15 行作为 reason 上报
- [x] **`daily_incremental_check.sh` PID 锁** — 新增 `/tmp/stock_daily_incremental.lock`，与 `daily_update.sh` 独立防重入

### 自动运维
- [x] **StuckTaskMonitor** — `server.js` 启动后每 5 分钟自动扫描所有 agent 的 `in_progress` 任务，超过 30 分钟无心跳自动标记为 `blocked`
- [x] **CleanupMonitor** — 每天自动归档超过 30 天的 `completed`/`cancelled` 任务（`archived=1` 软删除）
- [x] **归档管理 API** — `POST /archive-old?days=N` 手动归档，`DELETE /archived` 物理清理，`GET /todos` 默认排除已归档任务

---

## 🔄 进行中 / 待优化

### P1 — 重要

#### 1. WebSocket 实时推送
- **问题**：当前 Skill 需要轮询获取任务状态变更
- **方案**：TODO Server → Skill WebSocket 推送
- **影响**：减少轮询、实时性更好

#### 2. 可视化管理界面
- **问题**：当前只有 REST API，没有 Web UI
- **方案**：在 `public/` 下开发管理面板
- **功能**：任务看板、项目统计、agent 状态、通知中心

### P2 — 优化

#### 3. 飞书快捷按钮支持
- 在纠偏提示 / 任务确认消息底部增加快捷操作按钮
- 确认 / 跳过 / 创建 / 指派

#### 4. 单元测试 + 集成测试
- TODO Server API 测试（Jest / Mocha）
- Focus Engine 评分算法单元测试
- Skill 端到端测试

#### 5. Docker Compose 部署
- `Dockerfile` + `docker-compose.yml`
- 支持一键部署整个 TODO Server

---

## 📋 建议优先级

| 优先级 | 事项 | 预估工作量 | 收益 |
|--------|------|-----------|------|
| P1 | WebSocket 实时推送 | 1-2 天 | 中（体验提升） |
| P1 | 可视化管理界面 | 2-3 天 | 高（运维友好） |
| P2 | 单元测试 | 1-2 天 | 中（质量保障） |
| P2 | 飞书快捷按钮 | 0.5 天 | 低（体验优化） |
| P2 | Docker 部署 | 0.5 天 | 中（部署便利） |

---

## 🎯 里程碑

| 里程碑 | 状态 | 说明 |
|--------|------|------|
| **MVP** | ✅ 完成 | Server API + SDK + 聚焦引擎 + 心跳 |
| **V1.0** | ✅ 完成 | + 验收标准 + 漂移检测 + 熔断 + 多智能体协作 + Skill 接入 |
| **V1.1** | 🔄 计划 | + WebSocket + 可视化管理界面 |
| **V1.2** | 📋 计划中 | + Docker + 单元测试 + Python SDK |
