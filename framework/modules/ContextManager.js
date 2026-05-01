/**
 * 上下文管理器模块
 * 
 * 功能：
 * - 管理智能体的上下文窗口
 * - 注入任务相关信息
 * - 控制上下文长度和内容
 * - 优先级排序
 */

class ContextManager {
  constructor(framework) {
    this.framework = framework;
    this.conversationTurn = 0;
    this.lastInjectTurn = 0;
  }

  async initialize() {
    this.framework.log('✅ ContextManager 模块已初始化');
  }

  /**
   * 获取上下文摘要
   */
  async getSummary() {
    const config = this.framework.config.features.contextManagement;
    
    try {
      const taskManager = this.framework.modules.taskManager;
      const taskInfo = await taskManager.getTaskInfo();

      const orderedPriorityTasks = await this.prioritizeByLLM(taskInfo.priorityTasks)
        || this.prioritizeTasks(taskInfo.priorityTasks, config.prioritizeBy);

      const summary = {
        overview: this.buildOverview(taskInfo),
        priorityTasks: orderedPriorityTasks,
        blockedTasks: taskInfo.blockedTasks,
        readyTasks: await taskManager.getReadyTasks()
      };

      const summaryText = JSON.stringify(summary);
      if (summaryText.length > config.maxContextLength) {
        summary.overflow = true;
        summary.truncated = this.truncateSummary(summary, config.maxContextLength);
      }

      return summary;
    } catch (error) {
      this.framework.log(`❌ 获取上下文摘要失败: ${error.message}`);
      return {
        overview: '无法获取任务信息',
        priorityTasks: [],
        blockedTasks: []
      };
    }
  }

  /**
   * 构建概览
   */
  buildOverview(taskInfo) {
    return `当前有 ${taskInfo.total} 个任务，其中 ${taskInfo.pending} 个待处理，${taskInfo.inProgress} 个进行中，${taskInfo.completed} 个已完成，${taskInfo.blocked} 个被阻塞。`;
  }

  /**
   * 优先级排序
   */
  prioritizeTasks(tasks, method = 'priority') {
    switch (method) {
      case 'priority':
        return tasks.sort((a, b) => {
          const order = { critical: 0, high: 1, medium: 2, low: 3 };
          return order[a.priority] - order[b.priority];
        });

      case 'recency':
        return tasks.sort((a, b) => 
          new Date(b.updated_at || 0) - new Date(a.updated_at || 0)
        );

      case 'dependency':
        return tasks.sort((a, b) => 
          (b.dependencies?.length || 0) - (a.dependencies?.length || 0)
        );

      default:
        return tasks;
    }
  }

  /**
   * LLM 智能排序（综合优先级 + 依赖 + 语义关联 + 难度评估）
   * 返回排序后的数组，失败时返回 null 以回退到规则排序
   */
  async prioritizeByLLM(tasks) {
    if (!tasks || tasks.length <= 1) return null;

    const llmManager = this.framework.modules.llmManager;
    if (!llmManager || !llmManager.hasProvider()) return null;

    const candidateList = tasks.map((t, i) => {
      let desc = `${i + 1}. [${t.priority}] ${t.title}`;
      if (t.description) desc += ` — ${t.description.substring(0, 80)}`;
      if (t.context) desc += ` (上下文: ${t.context.substring(0, 60)})`;
      const deps = t.dependencies || [];
      if (deps.length > 0) desc += ` [依赖: ${deps.length}项]`;
      if (t.attempt_count > 0) desc += ` [已尝试${t.attempt_count}次]`;
      return desc;
    }).join('\n');

    const prompt = `你是一个任务优先级分析专家。请根据以下候选任务，返回一个最合理的执行顺序排列（从最应该先做的到最后做的）。

排序综合考虑：
1. 紧急程度 — 优先级高的先做
2. 依赖解锁 — 完成后能解锁更多后续任务的先做
3. 完成难度 — 可快速产出结果的适当优先（快速交付）
4. 尝试次数 — 多次失败的任务需要关注但不一定最先做
5. 上下文连续性 — 与当前工作流相关的优先

候选任务列表：
${candidateList}

请返回纯 JSON，不要包含其他文字：
{"ordered_indices": [0, 2, 1, 3], "reasoning": "排序原因简述"}`;

    try {
      const result = await llmManager.chat({
        messages: [{ role: 'user', content: prompt }],
        system: '你是一个任务调度助手，请根据任务信息给出最优排序，只返回 JSON。'
      });

      const reply = result.content || '';
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.ordered_indices)) return null;

      const reordered = parsed.ordered_indices
        .filter(i => i >= 0 && i < tasks.length)
        .map(i => tasks[i]);

      if (reordered.length !== tasks.length) return null;

      return reordered;
    } catch (error) {
      this.framework.log(`⚠️ LLM 任务排序失败，回退到规则排序: ${error.message}`);
      return null;
    }
  }

  /**
   * 截断摘要
   */
  truncateSummary(summary, maxLength) {
    // 简单截断实现
    let result = '';
    
    if (summary.priorityTasks) {
      result += '🎯 优先任务:\n';
      for (const task of summary.priorityTasks) {
        const taskStr = `${task.title} [${task.priority}]`;
        if (result.length + taskStr.length < maxLength * 0.8) {
          result += `- ${taskStr}\n`;
        } else {
          break;
        }
      }
    }

    return result;
  }

  /**
   * 判断是否应该注入上下文
   */
  shouldInject() {
    const config = this.framework.config.features.contextManagement;
    
    switch (config.injectInterval) {
      case 'every_turn':
        return true;

      case 'on_demand':
        return false; // 由外部控制

      case 'manual':
        return this.conversationTurn - this.lastInjectTurn >= 3;

      default:
        return true;
    }
  }

  /**
   * 标记已注入
   */
  markInjected() {
    this.lastInjectTurn = this.conversationTurn;
  }

  /**
   * 增加对话轮次
   */
  incrementTurn() {
    this.conversationTurn++;
  }

  /**
   * 获取格式化上下文
   */
  getFormattedContext(summary) {
    let formatted = '\n\n=== 📋 任务上下文 ===\n\n';

    // 概览
    formatted += summary.overview + '\n\n';

    // 优先任务
    if (summary.priorityTasks && summary.priorityTasks.length > 0) {
      formatted += '🎯 优先任务:\n';
      summary.priorityTasks.forEach((task, index) => {
        formatted += `${index + 1}. [${task.priority.toUpperCase()}] ${task.title}`;
        if (task.context) {
          formatted += `\n   📝 ${task.context.substring(0, 100)}${task.context.length > 100 ? '...' : ''}`;
        }
        formatted += '\n';
      });
      formatted += '\n';
    }

    // 被阻塞的任务
    if (summary.blockedTasks && summary.blockedTasks.length > 0) {
      formatted += '🚧 被阻塞的任务:\n';
      summary.blockedTasks.forEach(task => {
        formatted += `- ${task.title}\n`;
        if (task.waitingOn && task.waitingOn.length > 0) {
          formatted += `  └─ 等待: ${task.waitingOn.join(', ')}\n`;
        }
      });
      formatted += '\n';
    }

    // 可执行任务
    if (summary.readyTasks && summary.readyTasks.length > 0) {
      formatted += '✨ 可以立即开始的任务:\n';
      summary.readyTasks.slice(0, 3).forEach(task => {
        formatted += `- ${task.title} [${task.priority}]\n`;
      });
      formatted += '\n';
    }

    return formatted;
  }

  /**
   * 重置上下文管理器
   */
  reset() {
    this.conversationTurn = 0;
    this.lastInjectTurn = 0;
  }
}

module.exports = ContextManager;
