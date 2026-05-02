/**
 * Agent TODO SDK - 智能体任务管理客户端
 * 用于帮助 AI 智能体更好地管理任务，减少上下文膨胀和任务发散
 */

class AgentTODOSDK {
  constructor(baseUrl, agentId, secretKey) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.secretKey = secretKey;
  }

  async _request(method, endpoint, data = null) {
    const url = `${this.baseUrl}/api/agents/${this.agentId}${endpoint}`;

    const headers = {
      'Content-Type': 'application/json',
    };

    if (this.secretKey) {
      headers['X-Agent-Secret'] = this.secretKey;
    }

    const options = {
      method,
      headers,
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || `Request failed (${response.status})`);
      }

      return result;
    } catch (error) {
      console.error('TODO SDK Error:', error);
      throw error;
    }
  }

  // ==================== 任务管理 ====================

  async createTodo(options) {
    return this._request('POST', '/todos', options);
  }

  async getTodo(todoId) {
    return this._request('GET', `/todos/${todoId}`);
  }

  async listTodos(filters = {}) {
    const queryParams = new URLSearchParams(filters).toString();
    const endpoint = queryParams ? `/todos?${queryParams}` : '/todos';
    return this._request('GET', endpoint);
  }

  async updateTodo(todoId, data) {
    return this._request('PUT', `/todos/${todoId}`, data);
  }

  async deleteTodo(todoId) {
    return this._request('DELETE', `/todos/${todoId}`);
  }

  async completeTodo(todoId) {
    return this._request('PATCH', `/todos/${todoId}/status`, { status: 'completed' });
  }

  async updateStatus(todoId, status) {
    return this._request('PATCH', `/todos/${todoId}/status`, { status });
  }

  // ==================== 依赖关系管理 ====================

  async addDependency(todoId, dependencyId) {
    return this._request('POST', `/todos/${todoId}/dependencies`, { dependencyId });
  }

  async removeDependency(todoId, dependencyId) {
    return this._request('DELETE', `/todos/${todoId}/dependencies/${dependencyId}`);
  }

  async getDependencyTree(todoId) {
    return this._request('GET', `/todos/${todoId}/dependency-tree`);
  }

  // ==================== 项目管理 ====================

  async createProject(options) {
    return this._request('POST', '/projects', options);
  }

  async getProject(projectId) {
    return this._request('GET', `/projects/${projectId}`);
  }

  async listProjects() {
    return this._request('GET', '/projects');
  }

  async updateProject(projectId, data) {
    return this._request('PUT', `/projects/${projectId}`, data);
  }

  async deleteProject(projectId) {
    return this._request('DELETE', `/projects/${projectId}`);
  }

  // ==================== 上下文聚焦 ====================

  async getContextSummary() {
    return this._request('GET', '/todos/summary');
  }

  async getReadyTasks() {
    return this._request('GET', '/todos/ready');
  }

  async getStats() {
    return this._request('GET', '/todos/stats');
  }

  async searchTodos(query) {
    return this._request('GET', `/todos/search?q=${encodeURIComponent(query)}`);
  }

  // ==================== 便捷方法 ====================

  async focus() {
    const summary = await this.getContextSummary();
    const suggestions = summary.data.suggestion;
    const priorityTasks = summary.data.priority_tasks;

    let message = '\n📋 **当前任务状态**\n';
    message += `- 总任务: ${summary.data.overview.total}\n`;
    message += `- 活跃任务: ${summary.data.overview.active}\n`;
    message += `- 已完成: ${summary.data.overview.completed}\n`;
    message += `- 被阻塞: ${summary.data.overview.blocked}\n\n`;

    if (suggestions.length > 0) {
      message += '💡 **智能建议**\n';
      suggestions.forEach(s => {
        message += `${s.message}\n`;
      });
      message += '\n';
    }

    if (priorityTasks.length > 0) {
      message += '🎯 **优先任务**\n';
      priorityTasks.forEach((task, index) => {
        message += `${index + 1}. **[${task.priority.toUpperCase()}]** ${task.title}\n`;
        if (task.context) {
          message += `   📝 ${task.context}\n`;
        }
      });
      message += '\n';
    }

    if (summary.data.focus.currently_working_on.length > 0) {
      message += '⚡ **正在进行**\n';
      summary.data.focus.currently_working_on.forEach(task => {
        message += `- ${task.title} (${task.priority})\n`;
      });
      message += '\n';
    }

    if (summary.data.blocked.length > 0) {
      message += '🚧 **被阻塞的任务**\n';
      summary.data.blocked.forEach(task => {
        message += `- ${task.title}\n`;
        task.waiting_on.forEach(dep => {
          message += `  └─ 等待: ${dep.title} (${dep.status})\n`;
        });
      });
      message += '\n';
    }

    return {
      summary: summary.data,
      message
    };
  }

  async quickAdd(title, options = {}) {
    const todo = await this.createTodo({
      title,
      ...options
    });

    console.log(`✅ 任务已创建: ${title}`);
    return todo;
  }

  async startTask(todoId) {
    return this.updateStatus(todoId, 'in_progress');
  }

  async doneTask(todoId) {
    return this.completeTodo(todoId);
  }

  async proposeCompletion(todoId, summary = '') {
    return this.updateStatus(todoId, 'pending_validation');
  }

  async planTaskChain(tasks) {
    const results = [];

    for (let i = 0; i < tasks.length; i++) {
      const taskData = tasks[i];

      let dependencies = [];
      if (i > 0 && taskData.dependsOnPrevious !== false) {
        dependencies.push(results[i - 1].data.id);
      }

      const todo = await this.createTodo({
        ...taskData,
        dependencies
      });

      results.push(todo);

      if (dependencies.length > 0) {
        console.log(`🔗 任务 "${taskData.title}" 依赖于 "${tasks[i - 1].title}"`);
      }
    }

    return results;
  }

  // ==================== 聚焦管理（Focus Engine）====================

  async getFocus() {
    return this._request('GET', '/focus');
  }

  async setFocus(taskId, options = {}) {
    return this._request('PUT', '/focus', {
      taskId,
      focusMode: options.focusMode || 'manual',
      contextWindowSize: options.contextWindowSize || 10
    });
  }

  async autoFocus() {
    return this._request('POST', '/focus/auto');
  }

  // ==================== 心跳与重试管理 ====================

  async updateHeartbeat(todoId, heartbeatData) {
    return this._request('POST', `/todos/${todoId}/heartbeat`, heartbeatData);
  }

  async recordAttempt(todoId, attemptResult) {
    return this._request('POST', `/todos/${todoId}/attempt`, attemptResult);
  }

  async getSubtasks(todoId) {
    return this._request('GET', `/todos/${todoId}/subtasks`);
  }

  async getStuckTasks(maxIdleMinutes = 30) {
    return this._request('GET', `/todos/stuck/list?maxIdleMinutes=${maxIdleMinutes}`);
  }

  // ==================== 对话上下文管理 ====================

  async saveContext(sessionId, role, content, metadata) {
    return this._request('POST', '/contexts', {
      sessionId,
      role,
      content,
      metadata
    });
  }

  async getContexts(sessionId, limit = 100) {
    const query = sessionId
      ? `/contexts?sessionId=${encodeURIComponent(sessionId)}&limit=${limit}`
      : `/contexts?limit=${limit}`;
    return this._request('GET', query);
  }

  async getSessionSummary(sessionId) {
    return this._request('GET', `/contexts/summary?sessionId=${encodeURIComponent(sessionId)}`);
  }

  async deleteContexts(sessionId) {
    return this._request('DELETE', `/contexts?sessionId=${encodeURIComponent(sessionId)}`);
  }

  async pruneOldContexts(maxAgeDays = 30) {
    return this._request('DELETE', `/contexts?maxAgeDays=${maxAgeDays}`);
  }

  // ==================== 增强便捷方法 ====================

  async completeTodoWithConfirm(todoId) {
    const result = await this._request('PATCH', `/todos/${todoId}/complete`);
    if (result.parent_auto_completed) {
      console.log('✅ 父任务已自动完成');
    }
    return result;
  }

  // ==================== 多智能体协作 ====================

  async assignTask(todoId, targetAgentId, options = {}) {
    return this._request('POST', `/todos/${todoId}/assign`, {
      targetAgentId,
      note: options.note || '',
      preserveContext: options.preserveContext || false,
      transferFiles: options.transferFiles || []
    });
  }

  async transferTask(todoId, targetAgentId, options = {}) {
    return this._request('POST', `/todos/${todoId}/transfer`, {
      targetAgentId,
      note: options.note || '',
      preserveContext: options.preserveContext || false,
      transferFiles: options.transferFiles || []
    });
  }

  async getAssignedTasks(filters = {}) {
    const queryParams = new URLSearchParams(filters).toString();
    const endpoint = queryParams ? `/todos/assigned?${queryParams}` : '/todos/assigned';
    return this._request('GET', endpoint);
  }

  async getCreatedTasks(filters = {}) {
    const queryParams = new URLSearchParams(filters).toString();
    const endpoint = queryParams ? `/todos/created?${queryParams}` : '/todos/created';
    return this._request('GET', endpoint);
  }

  async getNotifications(unreadOnly = false) {
    return this._request('GET', `/notifications?unreadOnly=${unreadOnly}`);
  }

  async markNotificationRead(notificationId) {
    return this._request('POST', `/notifications/${notificationId}/read`);
  }

  async markAllNotificationsRead() {
    return this._request('POST', '/notifications/read-all');
  }

  async deleteOldNotifications(maxAgeDays = 7) {
    return this._request('DELETE', `/notifications?maxAgeDays=${maxAgeDays}`);
  }

  async getProjectBoard(projectId) {
    return this._request('GET', `/projects/${projectId}/board`);
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentTODOSDK;
}

if (typeof window !== 'undefined') {
  window.AgentTODOSDK = AgentTODOSDK;
}
