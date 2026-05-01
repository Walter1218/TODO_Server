/**
 * 任务管理器模块
 * 
 * 功能：
 * - 创建和管理任务
 * - 自动任务状态更新
 * - 任务优先级管理
 * - 任务依赖追踪
 */

class TaskManager {
  constructor(framework) {
    this.framework = framework;
    this.todo = null;
    this.pendingUpdates = [];
  }

  async initialize() {
    const AgentTODOSDK = require('../../sdk/agent-todo-sdk.js');
    this.todo = new AgentTODOSDK(
      this.framework.config.base.todoServerUrl,
      this.framework.config.base.agentId,
      this.framework.config.base.agentSecret
    );
    
    this.framework.log('✅ TaskManager 模块已初始化');
  }

  /**
   * 获取任务信息摘要
   */
  async getTaskInfo() {
    try {
      const summary = await this.todo.getContextSummary();
      const stats = summary.data.overview;
      const priorityTasks = summary.data.priority_tasks || [];
      const blockedTasks = summary.data.blocked || [];

      return {
        total: stats.total,
        pending: stats.active,
        inProgress: summary.data.focus?.currently_working_on?.length || 0,
        completed: stats.completed,
        blocked: stats.blocked,
        priorityTasks: priorityTasks.slice(0, 5).map(t => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          context: t.context
        })),
        blockedTasks: blockedTasks.slice(0, 5).map(t => ({
          id: t.id,
          title: t.title,
          waitingOn: t.waiting_on?.map(w => w.title) || []
        }))
      };
    } catch (error) {
      this.framework.log(`❌ 获取任务信息失败: ${error.message}`);
      return {
        total: 0,
        pending: 0,
        inProgress: 0,
        completed: 0,
        blocked: 0,
        priorityTasks: [],
        blockedTasks: []
      };
    }
  }

  /**
   * 创建任务
   */
  async createTask(options) {
    try {
      const result = await this.todo.quickAdd(options.title, {
        description: options.description,
        priority: options.priority || this.framework.config.features.taskManagement.priority,
        context: options.context,
        tags: options.tags,
        projectId: options.projectId,
        parentId: options.parentId
      });

      this.framework.log(`✅ 任务已创建: ${options.title}${options.parentId ? ' (子任务)' : ''}`);
      return result.data;
    } catch (error) {
      this.framework.log(`❌ 创建任务失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId, status) {
    try {
      const result = await this.todo.updateStatus(taskId, status);
      this.framework.log(`✅ 任务状态已更新: ${taskId} -> ${status}`);
      return result.data;
    } catch (error) {
      this.framework.log(`❌ 更新任务状态失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取可执行任务
   */
  async getReadyTasks() {
    try {
      const result = await this.todo.getReadyTasks();
      return result.data;
    } catch (error) {
      this.framework.log(`❌ 获取可执行任务失败: ${error.message}`);
      return [];
    }
  }

  /**
   * 添加依赖关系
   */
  async addDependency(taskId, dependencyId) {
    try {
      const result = await this.todo.addDependency(taskId, dependencyId);
      this.framework.log(`✅ 依赖关系已添加: ${taskId} -> ${dependencyId}`);
      return result.data;
    } catch (error) {
      this.framework.log(`❌ 添加依赖失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 完成任务
   */
  async completeTask(taskId) {
    return this.updateTaskStatus(taskId, 'completed');
  }

  /**
   * 开始任务
   */
  async startTask(taskId) {
    return this.updateTaskStatus(taskId, 'in_progress');
  }

  /**
   * 分析回复并自动更新任务
   */
  async analyzeAndUpdate(response, userMessage = '') {
    if (!this.framework.config.features.taskManagement.autoUpdateStatus) {
      return;
    }

    // 分析回复内容，识别任务完成情况
    const analysis = await this.analyzeResponseForTasks(response, userMessage);
    
    for (const taskAction of analysis) {
      if (taskAction.action === 'complete' && taskAction.taskId) {
        await this.completeTask(taskAction.taskId);
      } else if (taskAction.action === 'start' && taskAction.taskId) {
        await this.startTask(taskAction.taskId);
      }
    }
  }

  /**
   * 分析回复内容，提取任务信息
   */
  async analyzeResponseForTasks(response, userMessage = '') {
    const message = typeof response === 'string' ? response : response.message || '';
    const fullText = (userMessage || '') + "\n" + message;

    // 获取当前任务列表作为上下文
    let todos = [];
    try {
      const listResult = await this.todo.listTodos({ limit: 50 });
      todos = listResult.data || [];
    } catch (e) {
      this.framework.log(`⚠️ 获取任务列表失败: ${e.message}`);
    }

    if (todos.length === 0) {
      return [];
    }

    // 构建 LLM prompt
    const todoList = todos.map((t, i) => {
      return `${i + 1}. [${t.status}] [${t.priority}] ${t.title}${t.description ? " - " + t.description : ""}`;
    }).join("\n");

    const systemPrompt = `你是一个任务状态分析助手。请根据用户和AI的对话内容，判断是否有任务的状态应该被更新。

当前任务列表：
${todoList}

请分析对话，判断用户或AI是否：
1. 完成了某个任务（提到了"完成"、"搞定"、"done"等，且确实有对应的任务）
2. 开始执行某个任务（提到了"开始"、"着手"等，且确实有对应的任务）
3. 或者没有需要更新的任务

你必须只返回纯JSON数组格式，不要包含任何其他文字。格式示例：
[
  {"action": "complete", "taskIndex": 1, "reason": "用户明确说已完成数据导入"},
  {"action": "start", "taskIndex": 3, "reason": "AI表示开始处理代码重构"}
]
如果没有需要更新的任务，返回空数组：[]`;

    const llmManager = this.framework.modules.llmManager;
    if (!llmManager || !llmManager.hasProvider()) {
      this.framework.log('⚠️ LLM 未配置，回退到关键词匹配');
      return this._fallbackKeywordMatch(fullText);
    }

    try {
      const result = await llmManager.chat({
        messages: [{ role: "user", content: fullText }],
        system: systemPrompt
      });

      const raw = result.content || "";
      // 提取 JSON
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.framework.log(`⚠️ LLM 返回无法解析: ${raw.substring(0, 100)}`);
        return [];
      }

      const actions = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(actions)) {
        return [];
      }

      // 将 taskIndex 映射为 taskId
      const mapped = [];
      for (const a of actions) {
        const idx = (a.taskIndex || a.task_index || 1) - 1;
        if (idx >= 0 && idx < todos.length) {
          mapped.push({
            action: a.action,
            taskId: todos[idx].id,
            reason: a.reason || "LLM分析"
          });
        }
      }

      this.framework.log(`🤖 LLM 任务分析结果: ${mapped.length} 个操作`);
      return mapped;
    } catch (error) {
      this.framework.log(`❌ LLM 任务分析失败: ${error.message}`);
      return this._fallbackKeywordMatch(fullText);
    }
  }

  /**
   * 关键词匹配回退方案
   */
  _fallbackKeywordMatch(text) {
    const actions = [];
    const completionKeywords = ['完成', 'done', 'finished', '搞定了', '结束了'];
    const startKeywords = ['开始', 'start', '着手', '进行'];

    for (const keyword of completionKeywords) {
      if (text.includes(keyword)) {
        actions.push({ action: 'complete', keyword, confidence: 'low' });
      }
    }
    for (const keyword of startKeywords) {
      if (text.includes(keyword)) {
        actions.push({ action: 'start', keyword, confidence: 'low' });
      }
    }
    return actions;
  }

  /**
   * 规划任务链
   */
  async planTaskChain(tasks) {
    try {
      const result = await this.todo.planTaskChain(tasks);
      this.framework.log(`✅ 任务链已规划: ${tasks.length} 个任务`);
      return result;
    } catch (error) {
      this.framework.log(`❌ 规划任务链失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 获取任务详情
   */
  async getTask(taskId) {
    try {
      const result = await this.todo.getTodo(taskId);
      return result.data;
    } catch (error) {
      this.framework.log(`❌ 获取任务详情失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 搜索任务
   */
  async searchTasks(query) {
    try {
      const result = await this.todo.searchTodos(query);
      return result.data;
    } catch (error) {
      this.framework.log(`❌ 搜索任务失败: ${error.message}`);
      return [];
    }
  }

  /**
   * LLM 驱动的任务自动发现
   */
  async discoverNewTasks(conversationText) {
    const llmManager = this.framework.modules.llmManager;
    if (!llmManager || !llmManager.hasProvider()) {
      this.framework.log('⚠️ LLM 未配置，跳过任务自动发现');
      return [];
    }

    // 获取已有任务列表，避免重复创建
    let existingTasks = [];
    try {
      const listResult = await this.todo.listTodos({ limit: 50 });
      existingTasks = listResult.data || [];
    } catch (e) {
      this.framework.log(`⚠️ 获取任务列表失败: ${e.message}`);
    }

    const existingTitles = existingTasks.map(t => t.title).join('\n');

    const systemPrompt = `你是一个任务发现助手。请分析对话内容，判断用户或AI是否提出了新的待办任务。

已有任务列表（避免重复）：
${existingTitles || '（无）'}

提取规则：
1. 只提取用户明确表达"要做"、"需要弄"、"回头处理"等意图的事项
2. 忽略闲聊、假设性讨论、已经明确在做的任务
3. 如果事项已经在"已有任务列表"中，不要重复提取
4. 每个任务应该有清晰的标题和合理的优先级
5. 如果某个任务比较复杂（需要多个步骤才能完成），请将其拆分为一个父任务和若干子任务

子任务拆分规则：
- 父任务：描述整体目标（如"完成数据同步模块"）
- 子任务：描述具体步骤（如"编写API接口"、"编写单元测试"）
- 子任务通过 parentTitle 字段关联到父任务的标题

返回纯JSON数组：
[
  {"title": "父任务标题", "priority": "high/medium/low", "context": "补充说明", "tags": ["标签"], "acceptance_criteria": "验收标准"},
  {"title": "子任务1", "priority": "high", "context": "...", "parentTitle": "父任务标题"},
  {"title": "子任务2", "priority": "medium", "context": "...", "parentTitle": "父任务标题"}
]
没有新任务则返回空数组：[]`;

    try {
      const result = await llmManager.chat({
        messages: [{ role: 'user', content: conversationText }],
        system: systemPrompt
      });

      const raw = result.content || '';
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.framework.log(`⚠️ LLM 任务发现返回无法解析: ${raw.substring(0, 100)}`);
        return [];
      }

      const tasks = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(tasks)) {
        return [];
      }

      // 过滤掉与已有任务标题过于相似的
      const filtered = tasks.filter(t => {
        const title = t.title || '';
        return !existingTasks.some(et =>
          et.title === title ||
          et.title.includes(title) ||
          title.includes(et.title)
        );
      });

      this.framework.log(`🤖 LLM 发现 ${tasks.length} 个候选任务，${filtered.length} 个为新任务`);
      return filtered;
    } catch (error) {
      this.framework.log(`❌ LLM 任务发现失败: ${error.message}`);
      return [];
    }
  }
}

module.exports = TaskManager;
