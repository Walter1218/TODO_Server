/**
 * Prompt管理器模块
 * 
 * 功能：
 * - 角色模板系统
 * - 任务类型识别
 * - 动态Prompt注入
 * - 记忆增强
 * - 渐进式Prompt
 */

class PromptManager {
  constructor(framework) {
    this.framework = framework;
    this.promptHistory = [];
    this.version = 1;
    this.currentRole = 'general';
    this.conversationPhase = 'start';
    this.taskContext = {};
  }

  async initialize() {
    this.framework.log('✅ PromptManager 模块已初始化');
  }

  /**
   * 获取系统Prompt
   */
  async getSystemPrompt() {
    const config = this.framework.config.features.promptManagement;

    // 1. 获取角色Prompt
    let prompt = await this.getRolePrompt();

    // 2. 如果有自定义Prompt，添加到角色Prompt之后
    if (config.systemPrompt) {
      prompt += '\n\n' + config.systemPrompt;
    }

    // 3. 动态增强
    if (config.autoEnhance) {
      prompt = await this.enhancePrompt(prompt);
    }

    // 4. 添加检查清单
    if (config.addChecklist) {
      prompt += '\n\n' + this.getChecklist();
    }

    // 5. 添加进度信息
    if (config.addProgress) {
      prompt += '\n\n' + await this.getProgressSection();
    }

    // 6. 记忆增强
    prompt = await this.enhanceWithMemory(prompt);

    // 记录Prompt历史
    this.promptHistory.push({
      version: this.version++,
      timestamp: new Date().toISOString(),
      role: this.currentRole,
      phase: this.conversationPhase,
      length: prompt.length
    });

    return prompt;
  }

  /**
   * 获取角色Prompt
   */
  async getRolePrompt() {
    const roles = this.getRoleTemplates();
    const role = roles[this.currentRole] || roles.general;
    return role.template;
  }

  /**
   * 获取所有角色模板
   */
  getRoleTemplates() {
    return {
      general: {
        name: '通用助手',
        template: `你是一个智能助手，拥有任务管理能力。

核心能力：
- 任务追踪和管理
- 优先级判断
- 进度跟踪
- 记忆重要信息

工作原则：
1. 主动创建TODO任务
2. 及时更新任务状态
3. 定期检查任务进度
4. 记忆关键信息`
      },

      developer: {
        name: '开发者',
        template: `你是一个资深全栈工程师，精通多种编程语言和框架。

技术能力：
- 代码编写和review
- 调试和性能优化
- 架构设计
- 技术文档撰写

工作方式：
- 先理解需求，再制定计划
- 代码规范：清晰、可维护、可测试
- 任务分解：分解为可执行的小任务
- 进度更新：完成后立即标记

代码规范：
- 遵循项目代码风格
- 写注释说明复杂逻辑
- 考虑边界情况
- 确保代码可测试`
      },

      analyst: {
        name: '分析师',
        template: `你是一个专业数据分析师，擅长从数据中发现洞察。

分析能力：
- 数据清洗和预处理
- 统计分析和建模
- 可视化展示
- 报告撰写

工作流程：
1. 明确分析目标
2. 分解分析任务
3. 收集和验证数据
4. 执行分析
5. 生成报告

分析原则：
- 数据质量优先
- 结论基于事实
- 图表清晰易懂
- 建议可执行`
      },

      writer: {
        name: '写作助手',
        template: `你是一个专业文案写手，擅长各类写作场景。

写作能力：
- 营销文案
- 技术文档
- 报告总结
- 创意内容

写作原则：
1. 明确目标受众
2. 结构清晰
3. 语言精炼
4. 符合品牌调性

写作流程：
- 理解写作目标
- 列出大纲
- 分段撰写
- 校对优化`
      },

      researcher: {
        name: '研究员',
        template: `你是一个专业研究员，擅长信息收集和分析。

研究能力：
- 文献检索
- 信息整合
- 深度分析
- 报告撰写

研究方法：
- 明确研究问题
- 制定研究计划
- 收集和分析资料
- 保持客观中立
- 引用来源可靠

研究规范：
- 引用注明来源
- 区分事实和观点
- 逻辑严谨
- 结论有据可查`
      },

      planner: {
        name: '规划师',
        template: `你是一个战略规划师，擅长目标分解和进度管理。

规划能力：
- 目标拆解
- 任务优先级排序
- 时间规划
- 进度跟踪

规划原则：
1. 目标SMART化
2. 任务可执行
3. 考虑资源和时间
4. 留有缓冲

规划流程：
- 明确长期目标
- 分解为季度/月/周任务
- 设定里程碑
- 定期回顾调整`
      }
    };
  }

  /**
   * 设置当前角色
   */
  setRole(roleName) {
    const roles = this.getRoleTemplates();
    if (roles[roleName]) {
      this.currentRole = roleName;
      this.framework.log(`角色已切换: ${roles[roleName].name}`);
      return true;
    }
    return false;
  }

  /**
   * 获取所有可用角色
   */
  getAvailableRoles() {
    const roles = this.getRoleTemplates();
    return Object.entries(roles).map(([key, value]) => ({
      id: key,
      name: value.name
    }));
  }

  /**
   * 识别任务类型
   */
  async identifyTaskType(message) {
    const messageLower = message.toLowerCase();

    // 代码相关
    if (/代码|编程|开发|bug|api|函数|调试/.test(messageLower)) {
      return 'developer';
    }

    // 数据分析相关
    if (/分析|数据|统计|图表|报表|趋势/.test(messageLower)) {
      return 'analyst';
    }

    // 写作相关
    if (/写作|文案|文章|报告|文档|撰写/.test(messageLower)) {
      return 'writer';
    }

    // 研究相关
    if (/研究|调研|文献|论文|资料/.test(messageLower)) {
      return 'researcher';
    }

    // 规划相关
    if (/规划|计划|安排|日程|目标/.test(messageLower)) {
      return 'planner';
    }

    return 'general';
  }

  /**
   * 增强Prompt
   */
  async enhancePrompt(basePrompt) {
    const enhancements = [];

    // 任务聚焦指令
    enhancements.push(this.getTaskFocusInstructions());

    // 格式指导
    enhancements.push(this.getFormatGuidelines());

    // 行为约束
    enhancements.push(this.getBehavioralGuidelines());

    return basePrompt + '\n\n' + enhancements.join('\n\n');
  }

  /**
   * 任务聚焦指令
   */
  getTaskFocusInstructions() {
    return `当前任务聚焦指令：
- 优先处理高优先级任务
- 被阻塞的任务标记并说明原因
- 每个回复结尾简述下一步行动
- 避免做与当前任务无关的工作
- 主动识别和创建TODO任务`;
  }

  /**
   * 格式指导
   */
  getFormatGuidelines() {
    return `输出格式指导：
- 使用清晰的结构组织信息（标题、列表、表格）
- 重要信息使用列表或编号
- 代码和技术细节单独成段
- 进度汇报使用百分比或完成度`;
  }

  /**
   * 行为约束
   */
  getBehavioralGuidelines() {
    return `行为约束：
- 不确定时主动查询任务详情
- 遇到问题先尝试解决，无法解决时寻求帮助
- 偏离任务时主动回到任务主线
- 定期回顾原始任务目标`;
  }

  /**
   * 获取检查清单
   */
  getChecklist() {
    return `=== 📋 工作检查清单 ===

回复前确认：
□ 我的回复是否服务于当前任务目标？
□ 下一步行动是什么？
□ 需要更新TODO状态吗？
□ 工作是否偏离原始目标？

回复后思考：
→ 这次回复完成了什么？
→ 下一步应该做什么？
→ 需要创建新任务或更新状态？`;
  }

  /**
   * 获取进度部分
   */
  async getProgressSection() {
    try {
      const taskManager = this.framework.modules.taskManager;
      if (!taskManager) {
        return '';
      }

      const taskInfo = await taskManager.getTaskInfo();
      const progress = taskInfo.total > 0
        ? Math.round(taskInfo.completed / taskInfo.total * 100)
        : 0;

      return `=== 📊 当前进度 ===
总体进度：${progress}% (${taskInfo.completed}/${taskInfo.total} 个任务)
${taskInfo.blocked > 0 ? `⚠️ 有 ${taskInfo.blocked} 个任务被阻塞` : ''}
${taskInfo.inProgress > 0 ? `⚡ ${taskInfo.inProgress} 个任务进行中` : ''}`;
    } catch (error) {
      return '';
    }
  }

  /**
   * 记忆增强
   */
  async enhanceWithMemory(prompt) {
    try {
      const memoryManager = this.framework.modules.memoryManager;
      if (!memoryManager) {
        return prompt;
      }

      const recentMemory = await memoryManager.getRecentMemory();
      if (recentMemory.length === 0) {
        return prompt;
      }

      const memorySection = recentMemory
        .slice(0, 5)
        .map(m => `- ${m.content} (${m.type})`)
        .join('\n');

      return prompt + '\n\n相关记忆：\n' + memorySection;
    } catch (error) {
      return prompt;
    }
  }

  /**
   * 设置对话阶段
   */
  setConversationPhase(phase) {
    const validPhases = ['start', 'in_progress', 'review', 'completion'];
    if (validPhases.includes(phase)) {
      this.conversationPhase = phase;
      return true;
    }
    return false;
  }

  /**
   * 获取渐进式Prompt
   */
  async getPhasePrompt(phase) {
    const phasePrompts = {
      start: `当前任务刚开始，请：
1. 理解任务目标
2. 分解任务步骤
3. 创建TODO列表
4. 设定优先级`,

      in_progress: `任务进行中，请：
1. 专注当前任务
2. 定期更新进度
3. 标记阻塞点
4. 保持任务聚焦`,

      review: `任务回顾阶段，请：
1. 检查完成情况
2. 总结经验教训
3. 更新任务状态
4. 规划下一步`,

      completion: `任务已完成，请：
1. 确认所有子任务完成
2. 总结成果
3. 清理TODO列表
4. 存储重要记忆`
    };

    return phasePrompts[phase] || '';
  }

  /**
   * 设置任务上下文
   */
  setTaskContext(context) {
    this.taskContext = {
      ...this.taskContext,
      ...context,
      startTime: context.taskId ? new Date().toISOString() : this.taskContext.startTime
    };
  }

  /**
   * 获取任务上下文
   */
  getTaskContext() {
    return this.taskContext;
  }

  /**
   * 清除任务上下文
   */
  clearTaskContext() {
    this.taskContext = {};
    this.conversationPhase = 'start';
  }

  /**
   * 获取Prompt历史
   */
  getHistory() {
    return this.promptHistory;
  }

  /**
   * 创建Prompt模板
   */
  createPromptTemplate(name, template) {
    this.templates = this.templates || {};
    this.templates[name] = template;
  }

  /**
   * 使用模板
   */
  async useTemplate(name, variables = {}) {
    if (!this.templates || !this.templates[name]) {
      throw new Error(`模板 "${name}" 不存在`);
    }

    let prompt = this.templates[name];

    // 替换变量
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }

    return prompt;
  }
}

module.exports = PromptManager;
