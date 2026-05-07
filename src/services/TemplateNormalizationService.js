const Agent = require('../models/Agent');
const Todo = require('../models/Todo');
const Context = require('../models/Context');
const Notification = require('../models/Notification');

function extractJsonObject(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSchedule(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const validDaily = trimmed === 'daily';
  const validWeekly = /^weekly:(sun|mon|tue|wed|thu|fri|sat)(,(sun|mon|tue|wed|thu|fri|sat))*$/i.test(trimmed);
  const validCron = /^cron:\S+/.test(trimmed);
  const validLegacyCron = /^\d+\s+\d+\s+\S+\s+\S+\s+\S+$/.test(trimmed);
  return validDaily || validWeekly || validCron || validLegacyCron ? trimmed : null;
}

class TemplateNormalizationService {
  constructor(options = {}) {
    this.framework = options.framework || null;
    this.governorAgentId = options.governorAgentId || process.env.TEMPLATE_GOVERNOR_AGENT_ID || 'hermes-template-governor';
  }

  getLlmManager() {
    return this.framework?.modules?.llmManager || null;
  }

  ensureGovernorAgent() {
    if (!Agent.exists(this.governorAgentId)) {
      Agent.create({
        id: this.governorAgentId,
        name: this.governorAgentId,
        metadata: {
          auto_created: true,
          role: 'template_governor'
        }
      });
    }
    return Agent.findById(this.governorAgentId);
  }

  evaluateTemplate(template) {
    const missingFields = [];
    if (!normalizeSchedule(template.schedule)) missingFields.push('schedule');
    if (!isNonEmptyString(template.assigned_agent_id)) missingFields.push('assigned_agent_id');
    if (!isNonEmptyString(template.task_category)) missingFields.push('task_category');
    if (!isNonEmptyString(template.description)) missingFields.push('description');
    if (!isNonEmptyString(template.acceptance_criteria)) missingFields.push('acceptance_criteria');
    if (!Number.isInteger(template.max_attempts) || template.max_attempts <= 0) missingFields.push('max_attempts');

    return {
      templateId: template.id,
      title: template.title,
      missingFields,
      compliant: missingFields.length === 0
    };
  }

  listNonCompliantTemplates(agentId, options = {}) {
    const { templateIds = null, limit = 50 } = options;
    const idFilter = Array.isArray(templateIds) && templateIds.length > 0
      ? new Set(templateIds)
      : null;

    return Todo.findTemplates(agentId)
      .filter(template => !template.archived)
      .filter(template => !idFilter || idFilter.has(template.id))
      .map(template => ({
        template,
        report: this.evaluateTemplate(template)
      }))
      .filter(item => !item.report.compliant)
      .slice(0, limit);
  }

  buildPrompt(ownerAgentId, template, report) {
    return [
      '你要模拟一次模板治理 agent 与模板所属 agent 的双 Agent 对话，目标是修正不合格的定时模板。',
      '要求：',
      '1. 只能基于已有标题、描述、验收标准、上下文和字段缺口提出修正，不要臆造业务事实。',
      '2. 如果缺少 schedule，只有在标题/描述里已经明确出现频率或时间表达时才能补齐；否则标记需要人工确认。',
      '3. 输出必须是 JSON，不要输出额外文字。',
      '',
      '# 模板所属 agent',
      ownerAgentId,
      '',
      '# 模板信息',
      JSON.stringify({
        id: template.id,
        title: template.title,
        description: template.description || '',
        schedule: template.schedule || null,
        assigned_agent_id: template.assigned_agent_id || null,
        task_category: template.task_category || null,
        acceptance_criteria: template.acceptance_criteria || null,
        max_attempts: template.max_attempts,
        context: template.context || ''
      }, null, 2),
      '',
      '# 缺失字段',
      JSON.stringify(report.missingFields),
      '',
      '返回 JSON：',
      '{"summary":"...", "dialogue":[{"speaker":"owner","message":"..."},{"speaker":"governor","message":"..."}], "patch":{"schedule":null,"assignedAgentId":null,"taskCategory":null,"description":null,"acceptanceCriteria":null,"maxAttempts":null}, "requiresHumanReview":false, "humanReviewReason":""}'
    ].join('\n');
  }

  sanitizePatch(ownerAgentId, template, proposal = {}) {
    const patch = {};
    const patchSource = proposal.patch && typeof proposal.patch === 'object' ? proposal.patch : {};

    if (!isNonEmptyString(template.assigned_agent_id)) {
      patch.assignedAgentId = isNonEmptyString(patchSource.assignedAgentId)
        ? patchSource.assignedAgentId.trim()
        : ownerAgentId;
    }

    if (!isNonEmptyString(template.description)) {
      patch.description = isNonEmptyString(patchSource.description)
        ? patchSource.description.trim()
        : '';
    }

    if (!isNonEmptyString(template.acceptance_criteria)) {
      patch.acceptanceCriteria = isNonEmptyString(patchSource.acceptanceCriteria)
        ? patchSource.acceptanceCriteria.trim()
        : '';
    }

    if (!isNonEmptyString(template.task_category)) {
      patch.taskCategory = isNonEmptyString(patchSource.taskCategory)
        ? patchSource.taskCategory.trim()
        : '';
    }

    if (!Number.isInteger(template.max_attempts) || template.max_attempts <= 0) {
      const normalizedMaxAttempts = Number.parseInt(patchSource.maxAttempts, 10);
      patch.maxAttempts = Number.isInteger(normalizedMaxAttempts) && normalizedMaxAttempts > 0
        ? normalizedMaxAttempts
        : 3;
    }

    if (!normalizeSchedule(template.schedule)) {
      const normalizedSchedule = normalizeSchedule(patchSource.schedule);
      if (normalizedSchedule) {
        patch.schedule = normalizedSchedule;
        patch.isTemplate = true;
      }
    }

    return patch;
  }

  async requestDialogue(ownerAgentId, template, report) {
    const llmManager = this.getLlmManager();
    if (!llmManager || !llmManager.hasProvider || !llmManager.hasProvider()) {
      throw new Error('LLM not available for template normalization');
    }

    const prompt = this.buildPrompt(ownerAgentId, template, report);
    const result = await llmManager.chat({
      messages: [{ role: 'user', content: prompt }],
      system: '你是模板治理 agent，只返回 JSON，不输出额外说明。'
    });

    const reply = result?.content || '';
    const parsed = extractJsonObject(reply);
    if (!parsed) {
      return {
        reply,
        parsed: {
          summary: '治理 agent 未返回有效 JSON，系统已降级为规则兜底规范化。',
          dialogue: [
            { speaker: 'owner', message: `请治理模板 ${template.id} 的字段缺口` },
            { speaker: 'governor', message: '回复未能结构化解析，改由系统按规则兜底补齐可自动修复字段。' }
          ],
          patch: {},
          requiresHumanReview: true,
          humanReviewReason: '治理 agent 回复未返回有效 JSON'
        }
      };
    }

    return {
      reply,
      parsed
    };
  }

  async normalizeTemplateViaDialogue(ownerAgentId, template, options = {}) {
    const { dryRun = false } = options;
    this.ensureGovernorAgent();

    const report = this.evaluateTemplate(template);
    if (report.compliant) {
      return {
        templateId: template.id,
        title: template.title,
        status: 'already_compliant',
        missingFields: []
      };
    }

    const sessionId = `template-normalization:${template.id}`;
    Context.create(ownerAgentId, {
      sessionId,
      role: 'system',
      content: `[TemplateNormalization] 请求 ${this.governorAgentId} 评估模板 ${template.id} 的字段缺口：${report.missingFields.join(', ')}`,
      metadata: { type: 'template_normalization_request', template_id: template.id, target_agent_id: this.governorAgentId }
    });
    Context.create(this.governorAgentId, {
      sessionId,
      role: 'user',
      content: `[Agent2Agent] 来自 ${ownerAgentId} 的模板治理请求。请修正模板 ${template.id}：${template.title}`,
      metadata: { type: 'template_normalization_request', template_id: template.id, owner_agent_id: ownerAgentId }
    });

    const dialogue = await this.requestDialogue(ownerAgentId, template, report);
    const patch = this.sanitizePatch(ownerAgentId, template, dialogue.parsed);

    Context.create(this.governorAgentId, {
      sessionId,
      role: 'assistant',
      content: `[Agent2Agent] 治理建议：${dialogue.reply.slice(0, 1600)}`,
      metadata: {
        type: 'template_normalization_response',
        template_id: template.id,
        owner_agent_id: ownerAgentId,
        proposed_patch: patch
      }
    });

    let updatedTemplate = template;
    if (!dryRun && Object.keys(patch).length > 0) {
      updatedTemplate = Todo.update(ownerAgentId, template.id, patch);
    }

    const afterReport = dryRun ? this.evaluateTemplate({ ...template, ...patch }) : this.evaluateTemplate(updatedTemplate);
    const resolved = afterReport.compliant;
    const status = resolved
      ? 'normalized'
      : (Object.keys(patch).length > 0 ? 'partially_normalized' : 'requires_human_review');
    const requiresHumanReview = !resolved;

    Context.create(ownerAgentId, {
      sessionId,
      role: 'assistant',
      content: `[TemplateNormalization] ${resolved ? '已完成规范化修正' : '已生成规范化建议'}\nsummary=${dialogue.parsed.summary || ''}\nstatus=${status}`,
      metadata: {
        type: 'template_normalization_result',
        template_id: template.id,
        governor_agent_id: this.governorAgentId,
        status,
        dry_run: dryRun,
        remaining_missing_fields: afterReport.missingFields
      }
    });

    Notification.create(
      ownerAgentId,
      template.id,
      'comment',
      resolved
        ? `🧩 模板已通过 agent 对话完成规范化：${template.title}`
        : `🧩 模板已生成规范化建议，剩余缺口：${afterReport.missingFields.join(', ') || '无'}`
    );

    return {
      templateId: template.id,
      title: template.title,
      status,
      dryRun: dryRun === true,
      missingFieldsBefore: report.missingFields,
      missingFieldsAfter: afterReport.missingFields,
      patch,
      requiresHumanReview,
      humanReviewReason: requiresHumanReview
        ? (dialogue.parsed.humanReviewReason || '仍存在系统无法自动确认的缺口')
        : ''
    };
  }

  async normalizeNonCompliantTemplates(agentId, options = {}) {
    const { dryRun = false, limit = 50, templateIds = null } = options;
    const targets = this.listNonCompliantTemplates(agentId, { limit, templateIds });
    const results = [];

    for (const item of targets) {
      // 顺序处理，避免一次性堆满 LLM 调用和上下文写入
      // eslint-disable-next-line no-await-in-loop
      const result = await this.normalizeTemplateViaDialogue(agentId, item.template, { dryRun });
      results.push(result);
    }

    return {
      agentId,
      governorAgentId: this.governorAgentId,
      dryRun,
      scanned: targets.length,
      normalized: results.filter(item => item.status === 'normalized').length,
      partiallyNormalized: results.filter(item => item.status === 'partially_normalized').length,
      requiresHumanReview: results.filter(item => item.requiresHumanReview).length,
      results
    };
  }
}

module.exports = TemplateNormalizationService;
