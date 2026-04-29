/**

* 主动交互管理器模块
 * 
 * 功能：
 * - 主动提醒智能体关注任务
 * - 检测任务偏离
 * - 阻塞检测和提醒
 * - 周期性检查
 */

class ProactiveManager {
  constructor(framework) {
    this.framework = framework;
    this.conversationCount = 0;
    this.lastReminder = null;
    this.offTopicDetections = [];
  }

  async initialize() {
    this.framework.log('✅ ProactiveManager 模块已初始化');
  }

  /**
   * 判断是否应该提醒
   */
  shouldRemind() {
    const config = this.framework.config.features.proactiveInteraction;
    
    if (!config.enabled) {
      return null;
    }

    // 周期性提醒
    this.conversationCount++;
    
    if (this.conversationCount % config.remindInterval === 0) {
      return this.generatePeriodicReminder();
    }

    // 空闲时建议
    if (config.suggestOnIdle) {
      const idle = this.detectIdle();
      if (idle) {
        return this.generateIdleSuggestion();
      }
    }

    return null;
  }

  /**
   * 生成周期性提醒
   */
  async generatePeriodicReminder() {
    try {
      const taskManager = this.framework.modules.taskManager;
      const taskInfo = await taskManager.getTaskInfo();

      const reminders = [];

      // 紧急任务提醒
      if (taskInfo.priorityTasks.some(t => t.priority === 'critical')) {
        reminders.push('🚨 您有待处理的紧急任务，请优先处理。');
      }

      // 阻塞任务提醒
      if (taskInfo.blocked > 0) {
        reminders.push(`⚠️ 有 ${taskInfo.blocked} 个任务被阻塞，可以尝试解决依赖问题。`);
      }

      // 长时间未更新
      if (taskInfo.inProgress > 0) {
        reminders.push(`📌 您有 ${taskInfo.inProgress} 个进行中的任务，是否需要更新进度？`);
      }

      // 进度汇报
      if (taskInfo.total > 0) {
        const progress = Math.round(taskInfo.completed / taskInfo.total * 100);
        reminders.push(`📊 当前进度：${progress}% (${taskInfo.completed}/${taskInfo.total})`);
      }

      if (reminders.length > 0) {
        this.lastReminder = {
          type: 'periodic',
          content: reminders.join('\n'),
          timestamp: new Date().toISOString()
        };
        return this.lastReminder;
      }
    } catch (error) {
      this.framework.log(`⚠️ 生成周期性提醒失败: ${error.message}`);
    }

    return null;
  }

  /**
   * 生成空闲建议
   */
  async generateIdleSuggestion() {
    try {
      const readyTasks = await this.framework.modules.taskManager.getReadyTasks();
      
      if (readyTasks.length > 0) {
        const nextTask = readyTasks[0];
        return {
          type: 'suggestion',
          content: `💡 您有 ${readyTasks.length} 个任务可以开始。
          
建议开始：${nextTask.title}
${nextTask.context ? `背景：${nextTask.context.substring(0, 100)}...` : ''}`,
          timestamp: new Date().toISOString()
        };
      }
    } catch (error) {
      this.framework.log(`⚠️ 生成空闲建议失败: ${error.message}`);
    }

    return null;
  }

  /**
   * 检测是否空闲
   */
  detectIdle() {
    // 简单实现：如果连续3轮没有提到任务，则认为是空闲
    const recentMentions = this.offTopicDetections.slice(-3);
    return recentMentions.length >= 3 && recentMentions.every(d => !d.hasTaskMention);
  }

  /**
   * 检测是否偏离主题（LLM 语义分析版）
   */
  async detectDrift(userMessage, assistantReply, currentTask) {
    if (!currentTask) {
      return { is_drifted: false, drift_score: 0, reason: '无聚焦任务' };
    }

    const llmManager = this.framework.modules.llmManager;
    if (!llmManager || !llmManager.hasProvider()) {
      return this._fallbackDriftDetection(userMessage, currentTask);
    }

    const fullConversation = `用户：${userMessage}\n助手：${assistantReply || ''}`;

    const systemPrompt = `你是一个任务偏离度分析专家。请分析以下对话是否偏离了当前聚焦的任务。

当前聚焦任务：
标题：${currentTask.title}
描述：${currentTask.description || '无'}
上下文：${currentTask.context || '无'}
验收标准：${currentTask.acceptance_criteria || '无'}

偏离度评分标准：
- 0.0-0.3：完全在任务主线上，正常讨论
- 0.3-0.6：轻微偏离，聊到了相关话题但未跑题
- 0.6-0.8：中度偏离，明显在聊其他事情
- 0.8-1.0：严重偏离，完全无关

请只返回纯 JSON，不要包含其他文字：
{"drift_score": 0.0-1.0, "is_drifted": true/false, "reason": "简要说明原因", "severity": "none/mild/moderate/severe"}`;

    try {
      const result = await llmManager.chat({
        messages: [{ role: 'user', content: fullConversation }],
        system: systemPrompt
      });

      const raw = result.content || '';
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { is_drifted: false, drift_score: 0, reason: 'LLM 返回无法解析' };
      }

      const analysis = JSON.parse(jsonMatch[0]);
      return {
        is_drifted: !!analysis.is_drifted,
        drift_score: Math.min(1, Math.max(0, parseFloat(analysis.drift_score) || 0)),
        reason: analysis.reason || '',
        severity: analysis.severity || 'none'
      };
    } catch (error) {
      this.framework.log(`⚠️ LLM 偏离检测失败: ${error.message}`);
      return this._fallbackDriftDetection(userMessage, currentTask);
    }
  }

  /**
   * 生成纠偏提示
   */
  getDriftAlert(driftResult, currentTask) {
    if (!driftResult.is_drifted || driftResult.drift_score < 0.6) {
      return null;
    }

    const severity = driftResult.severity || 'moderate';
    const icon = severity === 'severe' ? '🚨' : '⚠️';

    let content = `${icon} 偏离提醒

我们的对话似乎偏离了当前聚焦的任务：
「${currentTask.title}」

偏离原因：${driftResult.reason}
偏离度：${Math.round(driftResult.drift_score * 100)}%

请选择下一步：
[A] 回到原任务继续执行
[B] 将刚才聊的内容记录为新任务
[C] 暂停当前任务，先处理新话题`;

    if (currentTask.acceptance_criteria) {
      content += `\n\n当前任务验收标准：\n${currentTask.acceptance_criteria}`;
    }

    return {
      type: 'drift_alert',
      severity,
      content,
      drift_score: driftResult.drift_score,
      current_task: {
        id: currentTask.id,
        title: currentTask.title
      }
    };
  }

  /**
   * 关键词回退偏离检测
   */
  _fallbackDriftDetection(message, currentTask) {
    if (!currentTask) {
      return { is_drifted: false, drift_score: 0, reason: '无聚焦任务' };
    }

    const taskKeywords = currentTask.tags || [];
    const messageLower = message.toLowerCase();

    const hasRelevantKeyword = taskKeywords.some(keyword =>
      messageLower.includes(keyword.toLowerCase())
    );

    const taskRelatedPatterns = [
      /任务|todo|task/,
      /完成|done|finish/,
      /工作|进展|进度/
    ];
    const hasTaskMention = taskRelatedPatterns.some(pattern =>
      pattern.test(message)
    );

    if (!hasRelevantKeyword && !hasTaskMention) {
      return { is_drifted: true, drift_score: 0.7, reason: '关键词检测：未提及任务相关内容' };
    }

    return { is_drifted: false, drift_score: 0.2, reason: '关键词检测：包含任务相关内容' };
  }

  /**
   * 旧方法保留兼容
   */
  detectOffTopic(message, currentTask) {
    // 同步包装异步方法（用于不阻塞的场景）
    const result = this._fallbackDriftDetection(message, currentTask);
    return {
      message,
      hasTaskMention: !result.is_drifted,
      isOffTopic: result.is_drifted,
      suggestion: result.is_drifted ? `⚠️ ${result.reason}` : null,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取检测历史
   */
  getOffTopicHistory() {
    return this.offTopicDetections;
  }

  /**
   * 重置计数器
   */
  reset() {
    this.conversationCount = 0;
    this.lastReminder = null;
    this.offTopicDetections = [];
  }
}

module.exports = ProactiveManager;
