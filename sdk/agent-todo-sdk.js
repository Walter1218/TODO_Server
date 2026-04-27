/**
 * Agent TODO SDK - 智能体任务管理客户端
 * 用于帮助 AI 智能体更好地管理任务，减少上下文膨胀和任务发散
 */

class AgentTODOSDK {
  constructor(baseUrl, agentId) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.agentId = agentId;
  }

  async _request(method, endpoint, data = null) {
    const url = `${this.baseUrl}/api/agents/${this.agentId}${endpoint}`;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Request failed');
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
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentTODOSDK;
}

if (typeof window !== 'undefined') {
  window.AgentTODOSDK = AgentTODOSDK;
}
