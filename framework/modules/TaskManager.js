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
      this.framework.config.base.agentId
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
        projectId: options.projectId
      });

      this.framework.log(`✅ 任务已创建: ${options.title}`);
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
  async analyzeAndUpdate(response) {
    if (!this.framework.config.features.taskManagement.autoUpdateStatus) {
      return;
    }

    // 分析回复内容，识别任务完成情况
    const analysis = await this.analyzeResponseForTasks(response);
    
    for (const taskAction of analysis) {
      if (taskAction.action === 'complete') {
        await this.completeTask(taskAction.taskId);
      } else if (taskAction.action === 'start') {
        await this.startTask(taskAction.taskId);
      }
    }
  }

  /**
   * 分析回复内容，提取任务信息
   */
  async analyzeResponseForTasks(response) {
    // 这里需要接入LLM来分析
    // 临时实现：基于关键词匹配
    
    const actions = [];
    const message = typeof response === 'string' ? response : response.message || '';
    
    const completionKeywords = ['完成', 'done', 'finished', '搞定了', '结束了'];
    const startKeywords = ['开始', 'start', '着手', '进行'];

    for (const keyword of completionKeywords) {
      if (message.includes(keyword)) {
        // 需要LLM来确定具体是哪个任务
        actions.push({
          action: 'complete',
          keyword,
          confidence: 'low' // 需要人工确认或LLM判断
        });
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
}

module.exports = TaskManager;
