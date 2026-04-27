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
    
    if (this.conversationCount % config.remendInterval === 0) {
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
   * 检测是否偏离主题
   */
  detectOffTopic(message, currentTask) {
    if (!this.framework.config.features.proactiveInteraction.blockOffTopic) {
      return { isOffTopic: false };
    }

    // 简单的关键词检测
    const taskKeywords = currentTask?.tags || [];
    const messageLower = message.toLowerCase();

    const hasRelevantKeyword = taskKeywords.some(keyword => 
      messageLower.includes(keyword.toLowerCase())
    );

    const detection = {
      message,
      hasTaskMention: false,
      isOffTopic: false,
      timestamp: new Date().toISOString()
    };

    // 检测消息中是否提到任务相关的内容
    const taskRelatedPatterns = [
      /任务|todo|task/,
      /完成|done|finish/,
      /工作|进展|进度/
    ];

    detection.hasTaskMention = taskRelatedPatterns.some(pattern => 
      pattern.test(message)
    );

    // 如果配置了阻止离题，且明显偏离主题
    if (currentTask && !hasRelevantKeyword && !detection.hasTaskMention) {
      detection.isOffTopic = true;
      detection.suggestion = `⚠️ 您似乎在讨论与当前任务"${currentTask.title}"无关的内容。是否需要回到主线任务？`;
    }

    this.offTopicDetections.push(detection);
    
    // 保持最近10条记录
    if (this.offTopicDetections.length > 10) {
      this.offTopicDetections = this.offTopicDetections.slice(-10);
    }

    return detection;
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
