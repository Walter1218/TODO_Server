/**
 * Prompt管理器模块
 * 
 * 功能：
 * - 管理智能体的系统Prompt
 * - 自动增强Prompt
 * - 添加检查清单和引导
 * - Prompt版本控制
 */

class PromptManager {
  constructor(framework) {
    this.framework = framework;
    this.promptHistory = [];
    this.version = 1;
  }

  async initialize() {
    this.framework.log('✅ PromptManager 模块已初始化');
  }

  /**
   * 获取系统Prompt
   */
  async getSystemPrompt() {
    const config = this.framework.config.features.promptManagement;
    
    let prompt = config.systemPrompt || this.getDefaultSystemPrompt();

    // 自动增强Prompt
    if (config.autoEnhance) {
      prompt = await this.enhancePrompt(prompt);
    }

    // 添加检查清单
    if (config.addChecklist) {
      prompt += '\n\n' + this.getChecklist();
    }

    // 添加进度信息
    if (config.addProgress) {
      prompt += '\n\n' + await this.getProgressSection();
    }

    // 记录Prompt版本
    this.promptHistory.push({
      version: this.version++,
      timestamp: new Date().toISOString(),
      length: prompt.length
    });

    return prompt;
  }

  /**
   * 获取默认系统Prompt
   */
  getDefaultSystemPrompt() {
    return `你是一个任务导向的AI助手。你有一个任务管理助手帮助你追踪和管理任务。

核心原则：
1. 始终关注当前任务目标，不要偏离
2. 完成任务后及时更新任务状态
3. 如果不确定任务背景，请查询任务详情
4. 不要凭空创造任务或信息
5. 定期检查任务进度，确保按时完成

与任务管理助手配合：
- 开始工作前，先了解当前任务状态
- 完成任务后，立即标记为完成
- 如果发现新任务，主动添加到任务列表
- 如果任务被阻塞，说明原因并寻求解决方案`;
  }

  /**
   * 增强Prompt
   */
  async enhancePrompt(basePrompt) {
    const enhancements = [];

    // 添加任务聚焦指令
    enhancements.push(`当前任务聚焦指令：
- 优先处理高优先级任务
- 被阻塞的任务标记并说明原因
- 每个回复结尾简述下一步行动
- 避免做与当前任务无关的工作`);

    // 添加格式指导
    enhancements.push(`输出格式指导：
- 使用清晰的结构组织信息
- 重要信息使用列表或编号
- 代码和技术细节单独成段
- 进度汇报使用百分比或完成度`);

    // 添加约束
    enhancements.push(`行为约束：
- 不确定时主动查询任务详情
- 遇到问题先尝试解决，无法解决时寻求帮助
- 偏离任务时主动回到任务主线
- 定期回顾原始任务目标`);

    return basePrompt + '\n\n' + enhancements.join('\n\n');
  }

  /**
   * 获取检查清单
   */
  getChecklist() {
    return `=== 📋 工作检查清单 ===

在回复前，请确认：

□ 我的回复是否服务于当前任务目标？
□ 我的下一步行动是什么？
□ 我是否需要更新任务状态？
□ 我的工作是否偏离了原始目标？
□ 我是否遗漏了重要的任务细节？

回复后，请思考：
→ 这次回复完成了什么？
→ 下一步应该做什么？
→ 是否需要创建新任务或更新现有任务？`;
  }

  /**
   * 获取进度部分
   */
  async getProgressSection() {
    try {
      const taskManager = this.framework.modules.taskManager;
      const taskInfo = await taskManager.getTaskInfo();

      return `=== 📊 当前进度 ===

总体进度：已完成 ${taskInfo.completed}/${taskInfo.total} 个任务 (${Math.round(taskInfo.completed / taskInfo.total * 100)}%)

${taskInfo.blocked > 0 ? `⚠️ 注意：有 ${taskInfo.blocked} 个任务被阻塞` : ''}
${taskInfo.inProgress > 0 ? `⚡ 进行中：${taskInfo.inProgress} 个任务` : ''}

请基于以上进度，合理安排工作。`;
    } catch (error) {
      return '';
    }
  }

  /**
   * 创建自定义Prompt模板
   */
  createPromptTemplate(name, template) {
    this.templates = this.templates || {};
    this.templates[name] = template;
  }

  /**
   * 使用模板生成Prompt
   */
  async useTemplate(name, variables = {}) {
    if (!this.templates || !this.templates[name]) {
      throw new Error(`Prompt模板 "${name}" 不存在`);
    }

    let prompt = this.templates[name];

    // 替换变量
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }

    // 添加检查清单等
    if (this.framework.config.features.promptManagement.addChecklist) {
      prompt += '\n\n' + this.getChecklist();
    }

    return prompt;
  }

  /**
   * 获取Prompt历史
   */
  getHistory() {
    return this.promptHistory;
  }
}

module.exports = PromptManager;
