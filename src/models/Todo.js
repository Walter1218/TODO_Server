const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const Context = require('./Context');
const DataTaskSpecService = require('../services/DataTaskSpecService');

// 安全解析 JSON 字段，处理可能的非 JSON 格式
const safeParseJson = (str, defaultValue = []) => {
  if (!str) return defaultValue;
  try {
    return JSON.parse(str);
  } catch {
    // 如果不是 JSON，尝试作为逗号分隔字符串处理
    if (typeof str === 'string' && !str.startsWith('[')) {
      return str.split(',').map(s => s.trim()).filter(Boolean);
    }
    return defaultValue;
  }
};

const safeParseObjectJson = (str, defaultValue = null) => {
  if (!str) return defaultValue;
  if (typeof str === 'object' && str !== null) return str;
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === 'object' ? parsed : defaultValue;
  } catch {
    return defaultValue;
  }
};

function normalizeTaskSpecValue(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'string') {
    return safeParseObjectJson(value, null);
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return null;
}

function hydrateTodoRecord(todo) {
  if (!todo) return todo;
  const runtimeTaskSpec = safeParseObjectJson(todo.task_spec, null);
  const effectiveTaskSpec = DataTaskSpecService.buildRuntimeTaskSpec({
    ...todo,
    task_spec: runtimeTaskSpec
  });
  return {
    ...todo,
    requires_plan: coerceBoolean(todo.requires_plan),
    tags: safeParseJson(todo.tags),
    dependencies: safeParseJson(todo.dependencies),
    attempt_log: safeParseJson(todo.attempt_log),
    heartbeat_blockers: safeParseJson(todo.heartbeat_blockers),
    task_spec: effectiveTaskSpec || runtimeTaskSpec
  };
}

const MONTH_NAME_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const DAY_NAME_MAP = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

function coerceDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  const normalized = typeof value === 'string'
    ? (() => {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
          // SQLite CURRENT_TIMESTAMP uses UTC without an offset; preserve that here.
          return `${trimmed.replace(' ', 'T')}Z`;
        }
        if (trimmed.includes(' ') && !trimmed.includes('T')) {
          return trimmed.replace(' ', 'T');
        }
        return trimmed;
      })()
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const MARKET_CLOSE_CATCHUP_MAX_DELAY_MS = 4 * 60 * 60 * 1000;

function isMarketCloseTemplate(template) {
  if (!template) return false;
  const text = [
    template.title,
    template.description,
    template.task_category,
    template.task_spec ? JSON.stringify(template.task_spec) : ''
  ].filter(Boolean).join(' ').toLowerCase();

  const cronExpr = String(template.schedule || '').startsWith('cron:')
    ? String(template.schedule).slice(5).trim()
    : String(template.schedule || '').trim();
  const hourField = cronExpr.split(/\s+/)[1] || '';
  const marketCloseHours = new Set(['16', '17', '18']);
  const marketKeywords = [
    'a股', 'tushare', 'daily_quote', 'daily_basic', 'stock.db',
    'moneyflow', 'top_list', 'adj_factor', 'block_trade', 'hsgt',
    'stk_limit', 'margin', 'margin_detail', 'index_daily',
    '日线', '分红', '资金流向', '龙虎榜', '复权', '大宗交易',
    '沪深港通', '涨跌停', '融资融券'
  ];

  return marketCloseHours.has(hourField)
    && marketKeywords.some(keyword => text.includes(keyword));
}

function shouldSkipCrossDayCatchup(template, referenceTime) {
  const nextDue = coerceDate(template?.next_due_at);
  const reference = coerceDate(referenceTime);
  if (!nextDue || !reference) return false;
  if (nextDue.getTime() > reference.getTime()) return false;
  if ((reference.getTime() - nextDue.getTime()) < MARKET_CLOSE_CATCHUP_MAX_DELAY_MS) return false;
  return isMarketCloseTemplate(template);
}

function normalizeCronNumber(token, aliasMap = null) {
  const raw = String(token).trim().toLowerCase();
  if (!raw) return null;
  if (aliasMap && Object.prototype.hasOwnProperty.call(aliasMap, raw)) {
    return aliasMap[raw];
  }
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  return parseInt(raw, 10);
}

function expandCronPart(part, min, max, aliasMap = null, normalizeValue = value => value) {
  const values = new Set();

  const addValue = (value) => {
    const normalized = normalizeValue(value);
    if (normalized >= min && normalized <= max) {
      values.add(normalized);
    }
  };

  const parseRange = (segment) => {
    if (segment === '*') {
      for (let i = min; i <= max; i++) addValue(i);
      return;
    }

    const [rangePart, stepPart] = segment.split('/');
    const step = stepPart ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      return;
    }

    if (rangePart === '*') {
      for (let i = min; i <= max; i += step) addValue(i);
      return;
    }

    if (rangePart.includes('-')) {
      const [startRaw, endRaw] = rangePart.split('-');
      const start = normalizeCronNumber(startRaw, aliasMap);
      const end = normalizeCronNumber(endRaw, aliasMap);
      if (start === null || end === null) return;
      for (let i = start; i <= end; i += step) addValue(i);
      return;
    }

    const single = normalizeCronNumber(rangePart, aliasMap);
    if (single === null) return;
    addValue(single);
  };

  for (const segment of String(part).split(',')) {
    parseRange(segment.trim());
  }

  return values;
}

function matchesCronField(part, value, min, max, aliasMap = null, normalizeValue = v => v) {
  if (!part || part === '*') return true;
  const allowed = expandCronPart(part, min, max, aliasMap, normalizeValue);
  return allowed.has(normalizeValue(value));
}

function matchesCronDate(parts, date) {
  const [minutePart, hourPart, dayOfMonthPart, monthPart, dayOfWeekPart] = parts;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  if (!matchesCronField(minutePart, minute, 0, 59)) return false;
  if (!matchesCronField(hourPart, hour, 0, 23)) return false;
  if (!matchesCronField(monthPart, month, 1, 12, MONTH_NAME_MAP)) return false;

  const domWildcard = !dayOfMonthPart || dayOfMonthPart === '*';
  const dowWildcard = !dayOfWeekPart || dayOfWeekPart === '*';
  const domMatches = matchesCronField(dayOfMonthPart || '*', dayOfMonth, 1, 31);
  const dowMatches = matchesCronField(dayOfWeekPart || '*', dayOfWeek, 0, 7, DAY_NAME_MAP, value => value === 7 ? 0 : value);

  if (domWildcard && dowWildcard) return true;
  if (domWildcard) return dowMatches;
  if (dowWildcard) return domMatches;
  return domMatches || dowMatches;
}

function findNextCronOccurrence(cronExpr, fromTime) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const from = coerceDate(fromTime);
  if (!from) return null;

  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // 逐分钟向前搜索，使用当前机器的本地时区判断 cron 字段。
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCronDate(parts, candidate)) {
      return candidate.toISOString();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

function isSameInstant(a, b) {
  const left = coerceDate(a);
  const right = coerceDate(b);
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}

function normalizeTextValue(value) {
  if (typeof value !== 'string') return value;
  return value.trim();
}

function normalizeNullableTextValue(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed || null;
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return Boolean(value);
}

function coercePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function hasOwn(data, key) {
  return Object.prototype.hasOwnProperty.call(data, key);
}

class Todo {
  static inferTaskCategory(title = '', description = '') {
    const combined = `${title || ''} ${description || ''}`.toLowerCase();
    if (combined.includes('巡检') || combined.includes('inspection') || combined.includes('质量检查') || combined.includes('monitor')) {
      return 'inspection';
    }
    if (combined.includes('备份') || combined.includes('backup') || combined.includes('同步') || combined.includes('sync') || combined.includes('tushare')) {
      return 'script';
    }
    if (combined.includes('fix') || combined.includes('修复') || combined.includes('调整') || combined.includes('优化')) {
      return 'code_change';
    }
    return 'general';
  }

  static buildTemplateDescription(title, schedule) {
    return `定时模板任务：${title}。系统将按调度规则 ${schedule} 生成实例，请按验收标准执行并提交结果。`;
  }

  static buildDefaultAcceptanceCriteria(title, taskCategory = 'general') {
    if (taskCategory === 'inspection') {
      return `完成《${title}》后，需输出巡检结论、异常项、处理建议，并明确说明是否允许继续运行。`;
    }
    if (taskCategory === 'script') {
      return `完成《${title}》后，需提交执行结果、关键输出摘要、产出位置或目标库变更说明，并确认无致命报错。`;
    }
    if (taskCategory === 'code_change') {
      return `完成《${title}》后，需说明修改内容、影响范围、验证方式与结果，并确认不存在阻塞性问题。`;
    }
    return `完成《${title}》后，需提交结果摘要、关键证据与验收结论，确保他人可以据此复核。`;
  }

  static normalizeTaskInput(agentId, rawData = {}, options = {}) {
    const { existingTask = null, operation = 'create', enforceTemplateStandards = false } = options;
    const normalizedData = { ...rawData };
    const normalizationNotes = [];

    if (hasOwn(rawData, 'title')) {
      const trimmedTitle = normalizeTextValue(rawData.title);
      normalizedData.title = trimmedTitle;
      if (trimmedTitle !== rawData.title) normalizationNotes.push('title_trimmed');
    }

    if (hasOwn(rawData, 'description')) {
      const trimmedDescription = normalizeTextValue(rawData.description);
      normalizedData.description = trimmedDescription;
      if (trimmedDescription !== rawData.description) normalizationNotes.push('description_trimmed');
    }

    if (hasOwn(rawData, 'context')) {
      const trimmedContext = normalizeTextValue(rawData.context);
      normalizedData.context = trimmedContext;
      if (trimmedContext !== rawData.context) normalizationNotes.push('context_trimmed');
    }

    if (hasOwn(rawData, 'schedule')) {
      const trimmedSchedule = normalizeNullableTextValue(rawData.schedule);
      normalizedData.schedule = trimmedSchedule;
      if (trimmedSchedule !== rawData.schedule) normalizationNotes.push('schedule_trimmed');
    }

    if (hasOwn(rawData, 'assignedAgentId')) {
      const trimmedAssignedAgentId = normalizeNullableTextValue(rawData.assignedAgentId);
      normalizedData.assignedAgentId = trimmedAssignedAgentId;
      if (trimmedAssignedAgentId !== rawData.assignedAgentId) normalizationNotes.push('assigned_agent_trimmed');
    }

    if (hasOwn(rawData, 'acceptanceCriteria')) {
      const trimmedAcceptanceCriteria = normalizeTextValue(rawData.acceptanceCriteria);
      normalizedData.acceptanceCriteria = trimmedAcceptanceCriteria;
      if (trimmedAcceptanceCriteria !== rawData.acceptanceCriteria) normalizationNotes.push('acceptance_criteria_trimmed');
    }

    if (hasOwn(rawData, 'taskCategory')) {
      const trimmedTaskCategory = normalizeNullableTextValue(rawData.taskCategory);
      normalizedData.taskCategory = trimmedTaskCategory;
      if (trimmedTaskCategory !== rawData.taskCategory) normalizationNotes.push('task_category_trimmed');
    }

    if (hasOwn(rawData, 'taskSpec')) {
      normalizedData.taskSpec = normalizeTaskSpecValue(rawData.taskSpec);
      if (rawData.taskSpec !== normalizedData.taskSpec) normalizationNotes.push('task_spec_normalized');
    }

    if (hasOwn(rawData, 'priority')) {
      const allowedPriorities = ['low', 'medium', 'high', 'critical'];
      if (!allowedPriorities.includes(rawData.priority)) {
        normalizedData.priority = 'medium';
        normalizationNotes.push('priority_normalized_to_medium');
      }
    }

    if (hasOwn(rawData, 'maxAttempts')) {
      const normalizedMaxAttempts = coercePositiveInteger(rawData.maxAttempts, 3);
      normalizedData.maxAttempts = normalizedMaxAttempts;
      if (normalizedMaxAttempts !== rawData.maxAttempts) normalizationNotes.push('max_attempts_normalized');
    }

    if (hasOwn(rawData, 'tags') && !Array.isArray(rawData.tags)) {
      normalizedData.tags = rawData.tags ? [String(rawData.tags)] : [];
      normalizationNotes.push('tags_normalized_to_array');
    }

    if (hasOwn(rawData, 'dependencies') && !Array.isArray(rawData.dependencies)) {
      normalizedData.dependencies = rawData.dependencies ? [String(rawData.dependencies)] : [];
      normalizationNotes.push('dependencies_normalized_to_array');
    }

    const effectiveSchedule = hasOwn(normalizedData, 'schedule')
      ? normalizedData.schedule
      : (existingTask?.schedule || null);

    const requestedTemplate = hasOwn(normalizedData, 'isTemplate')
      ? coerceBoolean(normalizedData.isTemplate)
      : Boolean(existingTask?.is_template);

    const effectiveIsTemplate = effectiveSchedule ? true : requestedTemplate;
    if (effectiveSchedule && normalizedData.isTemplate !== true) {
      normalizationNotes.push('template_flag_forced_from_schedule');
    }
    normalizedData.isTemplate = effectiveIsTemplate;

    const shouldEnforceTemplateStandards = operation === 'create' || enforceTemplateStandards;
    if (effectiveIsTemplate && shouldEnforceTemplateStandards) {
      const effectiveTitle = hasOwn(normalizedData, 'title')
        ? normalizedData.title
        : (existingTask?.title || '');

      const effectiveDescription = hasOwn(normalizedData, 'description')
        ? normalizedData.description
        : (existingTask?.description || '');

      const effectiveAssignedAgentId = hasOwn(normalizedData, 'assignedAgentId')
        ? normalizedData.assignedAgentId
        : (existingTask?.assigned_agent_id || null);

      if (!effectiveAssignedAgentId) {
        normalizedData.assignedAgentId = agentId;
        normalizationNotes.push('template_assigned_agent_defaulted');
      }

      if (!effectiveDescription) {
        normalizedData.description = this.buildTemplateDescription(effectiveTitle || '未命名任务', effectiveSchedule || '未设置');
        normalizationNotes.push('template_description_defaulted');
      }

      const inferredCategory = this.inferTaskCategory(
        effectiveTitle || existingTask?.title || '',
        normalizedData.description || effectiveDescription || ''
      );

      if (!normalizedData.taskCategory) {
        normalizedData.taskCategory = inferredCategory;
        normalizationNotes.push('task_category_inferred');
      }

      const effectiveAcceptanceCriteria = hasOwn(normalizedData, 'acceptanceCriteria')
        ? normalizedData.acceptanceCriteria
        : (existingTask?.acceptance_criteria || '');

      if (!effectiveAcceptanceCriteria) {
        normalizedData.acceptanceCriteria = this.buildDefaultAcceptanceCriteria(
          effectiveTitle || existingTask?.title || '未命名任务',
          normalizedData.taskCategory || inferredCategory
        );
        normalizationNotes.push('template_acceptance_criteria_defaulted');
      }
    }

    if (!normalizedData.taskCategory) {
      const effectiveTitle = hasOwn(normalizedData, 'title')
        ? normalizedData.title
        : (existingTask?.title || '');
      const effectiveDescription = hasOwn(normalizedData, 'description')
        ? normalizedData.description
        : (existingTask?.description || '');
      normalizedData.taskCategory = this.inferTaskCategory(effectiveTitle, effectiveDescription);
    }

    return {
      normalizedData,
      normalizationNotes: Array.from(new Set(normalizationNotes))
    };
  }

  static validateNormalizedTaskInput(data, options = {}) {
    const { existingTask = null } = options;
    const errors = [];
    const effectiveTitle = hasOwn(data, 'title') ? data.title : existingTask?.title;
    const effectiveSchedule = hasOwn(data, 'schedule') ? data.schedule : existingTask?.schedule;
    const effectiveIsTemplate = hasOwn(data, 'isTemplate') ? data.isTemplate : Boolean(existingTask?.is_template);

    if (!effectiveTitle) {
      errors.push('TODO title is required');
    }

    if (effectiveIsTemplate && !effectiveSchedule) {
      errors.push('模板任务必须提供 schedule');
    }

    return errors;
  }

  static create(agentId, data) {
    const db = getDb();
    const id = data.id || uuidv4();
    const { normalizedData } = this.normalizeTaskInput(agentId, data, {
      operation: 'create',
      enforceTemplateStandards: true
    });
    const {
      title,
      description = '',
      status = 'pending',
      priority = 'medium',
      context = '',
      tags = [],
      dependencies = [],
      projectId = null,
      parentId = null,
      position = 0,
      acceptanceCriteria = '',
      criteriaConfirmed = false,
      maxAttempts = 3,
      schedule = null,
      isTemplate = false,
      assignedAgentId = null,
      taskCategory = 'general',
      validationReport = '',
      validatedBy = null,
      validationCount = 0,
      taskSpec = null,
      requiresPlan = false,
      planStatus = 'not_required',
      currentPlanId = null,
      currentStepId = null,
      executionState = 'idle',
      leaseExpiresAt = null,
      lastActionAt = null
    } = normalizedData;
    const failureBucket = data.failureBucket === undefined ? null : data.failureBucket;

    // Auto-set isTemplate=true if schedule is provided but isTemplate not explicitly set
    // This prevents LLM from forgetting to mark scheduled tasks as templates
    let finalIsTemplate = isTemplate;
    if (schedule && data.isTemplate === undefined) {
      finalIsTemplate = true;
    }

    // Compute next due date for scheduled tasks
    const nextDueAt = schedule ? this.computeNextDueAt(schedule, new Date()) : null;

    const stmt = db.prepare(`
      INSERT INTO todos (
        id, agent_id, project_id, parent_id, title, description, status, priority,
        context, tags, dependencies, position,
        acceptance_criteria, criteria_confirmed, max_attempts,
        origin_agent_id, assigned_agent_id, schedule, is_template, next_due_at,
        validation_report, validated_by, validation_count, task_category, task_spec, failure_bucket,
        requires_plan, plan_status, current_plan_id, current_step_id, execution_state, lease_expires_at, last_action_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, agentId, projectId, parentId, title, description, status, priority,
      context, JSON.stringify(tags), JSON.stringify(dependencies), position,
      acceptanceCriteria, criteriaConfirmed ? 1 : 0, maxAttempts,
      agentId, assignedAgentId, schedule, finalIsTemplate ? 1 : 0, nextDueAt,
      validationReport, validatedBy, validationCount, taskCategory, taskSpec ? JSON.stringify(taskSpec) : null, failureBucket,
      requiresPlan ? 1 : 0, planStatus, currentPlanId, currentStepId, executionState, leaseExpiresAt, lastActionAt
    );
    const created = this.findById(agentId, id);
    try {
      const JobRunService = require('../services/JobRunService');
      JobRunService.syncTaskState(agentId, created, null, { source: 'todo_create' });
    } catch (err) {
      console.error('[Todo] syncTaskState(create) failed:', err.message);
    }
    return created;
  }

  static findById(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE id = ? AND agent_id = ?');
    const todo = stmt.get(id, agentId);

    return hydrateTodoRecord(todo);
  }

  static findByTitle(agentId, title) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE agent_id = ? AND title = ? ORDER BY created_at DESC LIMIT 1');
    const todo = stmt.get(agentId, title);

    return hydrateTodoRecord(todo);
  }

  static findAllByAgent(agentId, filters = {}) {
    const db = getDb();
    const { status, priority, tags, projectId, isTemplate, title, includeArchived, limit = 100, offset = 0, source, todayOnly } = filters;

    let query = 'SELECT * FROM todos WHERE agent_id = ?';
    const params = [agentId];

    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }

    if (priority) {
      query += ' AND priority = ?';
      params.push(priority);
    }

    if (projectId) {
      query += ' AND project_id = ?';
      params.push(projectId);
    }

    if (isTemplate !== undefined) {
      query += ' AND is_template = ?';
      params.push(isTemplate ? 1 : 0);
    }

    if (tags && tags.length > 0) {
      const tagConditions = tags.map(() => 'tags LIKE ?').join(' OR ');
      query += ` AND (${tagConditions})`;
      tags.forEach(tag => params.push(`%"${tag}"%`));
    }

    if (title) {
      query += ' AND title LIKE ?';
      params.push(`%${title}%`);
    }

    if (!includeArchived) {
      query += ' AND (archived = 0 OR archived IS NULL)';
    }

    if (todayOnly) {
      query += " AND date(created_at, 'localtime') = date('now', 'localtime')";
    }

    if (source === 'agent') {
      query += ' AND (origin_agent_id != ? OR assigned_agent_id = ?)';
      params.push(agentId, agentId);
    } else if (source === 'human') {
      query += ' AND origin_agent_id = ? AND (assigned_agent_id IS NULL OR assigned_agent_id = ?)';
      params.push(agentId, agentId);
    }

    query += ' ORDER BY CASE priority WHEN \'critical\' THEN 1 WHEN \'high\' THEN 2 WHEN \'medium\' THEN 3 ELSE 4 END, created_at DESC';
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const stmt = db.prepare(query);
    const todos = stmt.all(...params);

    return todos.map(hydrateTodoRecord);
  }

  static update(agentId, id, data) {
    const db = getDb();
    const existingTask = this.findById(agentId, id);
    const { normalizedData } = this.normalizeTaskInput(agentId, data, {
      operation: 'update',
      existingTask,
      enforceTemplateStandards: Boolean(
        hasOwn(data, 'schedule')
        || hasOwn(data, 'isTemplate')
        || hasOwn(data, 'assignedAgentId')
        || hasOwn(data, 'acceptanceCriteria')
        || hasOwn(data, 'description')
        || hasOwn(data, 'title')
        || hasOwn(data, 'taskCategory')
        || hasOwn(data, 'taskSpec')
      )
    });
    const {
      title,
      description,
      status,
      priority,
      context,
      tags,
      dependencies,
      projectId,
      parentId,
      position,
      acceptanceCriteria,
      criteriaConfirmed,
      maxAttempts,
      attemptCount,
      attemptLog,
      lastHeartbeat,
      heartbeatProgress,
      heartbeatStep,
      heartbeatBlockers,
      assignedAgentId,
      assignmentNote,
      schedule,
      isTemplate,
      expectedDurationMinutes,
      validationReport,
      validatedBy,
      validationCount,
      validationDeadline,
      archived,
      taskCategory,
      taskSpec,
      requiresPlan,
      planStatus,
      currentPlanId,
      currentStepId,
      executionState,
      leaseExpiresAt,
      lastActionAt
    } = normalizedData;
    const failureBucket = Object.prototype.hasOwnProperty.call(data, 'failureBucket')
      ? data.failureBucket
      : undefined;
    const circuitOpenUntil = Object.prototype.hasOwnProperty.call(data, 'circuitOpenUntil')
      ? data.circuitOpenUntil
      : undefined;
    const lastPreflightAt = Object.prototype.hasOwnProperty.call(data, 'lastPreflightAt')
      ? data.lastPreflightAt
      : undefined;
    const lastPreflightStatus = Object.prototype.hasOwnProperty.call(data, 'lastPreflightStatus')
      ? data.lastPreflightStatus
      : undefined;
    const lastPreflightReport = Object.prototype.hasOwnProperty.call(data, 'lastPreflightReport')
      ? data.lastPreflightReport
      : undefined;
    const completionReport = Object.prototype.hasOwnProperty.call(data, 'completionReport')
      ? data.completionReport
      : undefined;

    const updates = [];
    const values = [];

    if (title !== undefined) {
      updates.push('title = ?');
      values.push(title);
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status);

      if (status === 'completed') {
        updates.push('completed_at = CURRENT_TIMESTAMP');
      } else {
        updates.push('completed_at = NULL');
      }
    }

    if (priority !== undefined) {
      updates.push('priority = ?');
      values.push(priority);
    }

    if (context !== undefined) {
      updates.push('context = ?');
      values.push(context);
    }

    if (tags !== undefined) {
      updates.push('tags = ?');
      values.push(JSON.stringify(tags));
    }

    if (dependencies !== undefined) {
      updates.push('dependencies = ?');
      values.push(JSON.stringify(dependencies));
    }

    if (projectId !== undefined) {
      updates.push('project_id = ?');
      values.push(projectId);
    }

    if (parentId !== undefined) {
      updates.push('parent_id = ?');
      values.push(parentId);
    }

    if (position !== undefined) {
      updates.push('position = ?');
      values.push(position);
    }

    if (acceptanceCriteria !== undefined) {
      updates.push('acceptance_criteria = ?');
      values.push(acceptanceCriteria);
    }

    if (criteriaConfirmed !== undefined) {
      updates.push('criteria_confirmed = ?');
      values.push(criteriaConfirmed ? 1 : 0);
    }

    if (maxAttempts !== undefined) {
      updates.push('max_attempts = ?');
      values.push(maxAttempts);
    }

    if (attemptCount !== undefined) {
      updates.push('attempt_count = ?');
      values.push(attemptCount);
    }

    if (attemptLog !== undefined) {
      updates.push('attempt_log = ?');
      values.push(JSON.stringify(attemptLog));
    }

    if (lastHeartbeat !== undefined) {
      updates.push('last_heartbeat = ?');
      values.push(lastHeartbeat);
    }

    if (heartbeatProgress !== undefined) {
      updates.push('heartbeat_progress = ?');
      values.push(heartbeatProgress);
    }

    if (heartbeatStep !== undefined) {
      updates.push('heartbeat_step = ?');
      values.push(heartbeatStep);
    }

    if (heartbeatBlockers !== undefined) {
      updates.push('heartbeat_blockers = ?');
      values.push(JSON.stringify(heartbeatBlockers));
    }

    if (assignedAgentId !== undefined) {
      updates.push('assigned_agent_id = ?');
      values.push(assignedAgentId);
      updates.push('assigned_at = CURRENT_TIMESTAMP');
    }

    if (assignmentNote !== undefined) {
      updates.push('assignment_note = ?');
      values.push(assignmentNote);
    }

    if (expectedDurationMinutes !== undefined) {
      updates.push('expected_duration_minutes = ?');
      values.push(expectedDurationMinutes);
    }

    if (validationReport !== undefined) {
      updates.push('validation_report = ?');
      values.push(validationReport);
    }

    if (validatedBy !== undefined) {
      updates.push('validated_by = ?');
      values.push(validatedBy);
    }

    if (validationCount !== undefined) {
      updates.push('validation_count = ?');
      values.push(validationCount);
    }

    if (validationDeadline !== undefined) {
      updates.push('validation_deadline = ?');
      values.push(validationDeadline);
    }

    if (taskCategory !== undefined) {
      updates.push('task_category = ?');
      values.push(taskCategory);
    }

    if (taskSpec !== undefined) {
      updates.push('task_spec = ?');
      values.push(taskSpec ? JSON.stringify(taskSpec) : null);
    }

    if (requiresPlan !== undefined) {
      updates.push('requires_plan = ?');
      values.push(requiresPlan ? 1 : 0);
    }

    if (planStatus !== undefined) {
      updates.push('plan_status = ?');
      values.push(planStatus);
    }

    if (currentPlanId !== undefined) {
      updates.push('current_plan_id = ?');
      values.push(currentPlanId);
    }

    if (currentStepId !== undefined) {
      updates.push('current_step_id = ?');
      values.push(currentStepId);
    }

    if (executionState !== undefined) {
      updates.push('execution_state = ?');
      values.push(executionState);
    }

    if (leaseExpiresAt !== undefined) {
      updates.push('lease_expires_at = ?');
      values.push(leaseExpiresAt);
    }

    if (lastActionAt !== undefined) {
      updates.push('last_action_at = ?');
      values.push(lastActionAt);
    }

    if (failureBucket !== undefined) {
      updates.push('failure_bucket = ?');
      values.push(failureBucket);
    }

    if (circuitOpenUntil !== undefined) {
      updates.push('circuit_open_until = ?');
      values.push(circuitOpenUntil);
    }

    if (lastPreflightAt !== undefined) {
      updates.push('last_preflight_at = ?');
      values.push(lastPreflightAt);
    }

    if (lastPreflightStatus !== undefined) {
      updates.push('last_preflight_status = ?');
      values.push(lastPreflightStatus);
    }

    if (lastPreflightReport !== undefined) {
      updates.push('last_preflight_report = ?');
      values.push(lastPreflightReport);
    }

    if (completionReport !== undefined) {
      updates.push('completion_report = ?');
      values.push(completionReport);
    }

    if (archived !== undefined) {
      updates.push('archived = ?');
      values.push(archived ? 1 : 0);
    }

    if (schedule !== undefined) {
      updates.push('schedule = ?');
      values.push(schedule);
      // Recompute next_due_at when schedule changes
      if (schedule) {
        updates.push('next_due_at = ?');
        values.push(this.computeNextDueAt(schedule, new Date()));
      } else {
        updates.push('next_due_at = NULL');
        // Also clear template flag when schedule is removed
        updates.push('is_template = 0');
      }
    }

    if (isTemplate !== undefined) {
      updates.push('is_template = ?');
      values.push(isTemplate ? 1 : 0);
    }

    if (data.nextDueAt !== undefined) {
      updates.push('next_due_at = ?');
      values.push(data.nextDueAt);
    }

    if (data.lastSpawnedAt !== undefined) {
      updates.push('last_spawned_at = ?');
      values.push(data.lastSpawnedAt);
    }

    if (updates.length === 0) {
      return this.findById(agentId, id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id, agentId);

    const stmt = db.prepare(`
      UPDATE todos SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);

    stmt.run(...values);
    const refreshed = this.findById(agentId, id);
    try {
      const JobRunService = require('../services/JobRunService');
      JobRunService.syncTaskState(agentId, refreshed, existingTask, {
        source: 'todo_update',
        failureBucket
      });
    } catch (err) {
      console.error('[Todo] syncTaskState(update) failed:', err.message);
    }
    return this.findById(agentId, id);
  }

  static delete(agentId, id) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM todos WHERE id = ? AND agent_id = ?');
    const result = stmt.run(id, agentId);

    return result.changes > 0;
  }

  static complete(agentId, id) {
    return this.update(agentId, id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      heartbeatStep: '已完成',
      heartbeatBlockers: []
    });
  }

  static updateStatus(agentId, id, status) {
    return this.update(agentId, id, { status });
  }

  static getStats(agentId) {
    const db = getDb();

    const stmt = db.prepare(`
      SELECT
        SUM(CASE WHEN is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as total,
        SUM(CASE WHEN is_template = 0 AND (archived = 0 OR archived IS NULL) AND status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) as active_tasks,
        SUM(CASE WHEN status = 'pending' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'blocked' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN status = 'pending_validation' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as pending_validation,
        SUM(CASE WHEN status = 'validating' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as validating,
        SUM(CASE WHEN status = 'validation_failed' AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as validation_failed,
        SUM(CASE WHEN priority = 'critical' AND status NOT IN ('completed', 'cancelled') AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as critical_pending,
        SUM(CASE WHEN priority = 'high' AND status NOT IN ('completed', 'cancelled') AND is_template = 0 AND (archived = 0 OR archived IS NULL) THEN 1 ELSE 0 END) as high_pending
      FROM todos
      WHERE agent_id = ?
    `);

    return stmt.get(agentId);
  }

  static search(agentId, query) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ?
        AND (title LIKE ? OR description LIKE ? OR context LIKE ?)
      ORDER BY created_at DESC
    `);

    const searchTerm = `%${query}%`;
    const todos = stmt.all(agentId, searchTerm, searchTerm, searchTerm);

    return todos.map(hydrateTodoRecord);
  }

  static hasCircularDependency(agentId, todoId, newDependencies) {
    const db = getDb();

    if (todoId === 'new-todo' || !newDependencies || newDependencies.length === 0) {
      return false;
    }

    for (const depId of newDependencies) {
      const visited = new Set();
      const stack = [depId];

      while (stack.length > 0) {
        const currentId = stack.pop();

        if (currentId === todoId) {
          return true;
        }

        if (visited.has(currentId)) {
          continue;
        }

        visited.add(currentId);

        const stmt = db.prepare('SELECT dependencies FROM todos WHERE id = ? AND agent_id = ?');
        const row = stmt.get(currentId, agentId);

        if (row) {
          const deps = safeParseJson(row.dependencies);
          for (const d of deps) {
            if (!visited.has(d)) {
              stack.push(d);
            }
          }
        }
      }
    }

    return false;
  }

  static addDependency(agentId, todoId, dependencyId) {
    const todo = this.findById(agentId, todoId);
    if (!todo) {
      throw new Error('Todo not found');
    }

    const dependency = this.findById(agentId, dependencyId);
    if (!dependency) {
      throw new Error('Dependency todo not found');
    }

    const dependencies = [...todo.dependencies];
    if (!dependencies.includes(dependencyId)) {
      if (this.hasCircularDependency(agentId, todoId, [...dependencies, dependencyId])) {
        throw new Error('Circular dependency detected');
      }
      dependencies.push(dependencyId);
      return this.update(agentId, todoId, { dependencies });
    }

    return todo;
  }

  static removeDependency(agentId, todoId, dependencyId) {
    // Idempotent: return null if todo already gone
    const todo = this.findById(agentId, todoId);
    if (!todo) {
      return null;
    }

    const dependencies = todo.dependencies.filter(id => id !== dependencyId);
    return this.update(agentId, todoId, { dependencies });
  }

  static getReadyTasks(agentId) {
    const db = getDb();
    const allTodos = this.findAllByAgent(agentId, {});

    const completedOrCancelled = new Set(
      allTodos
        .filter(t => t.status === 'completed' || t.status === 'cancelled')
        .map(t => t.id)
    );

    return allTodos.filter(todo => {
      if (todo.status !== 'pending') {
        return false;
      }

      if (todo.dependencies.length === 0) {
        return true;
      }

      return todo.dependencies.every(depId => completedOrCancelled.has(depId));
    });
  }

  static getDependencyTree(agentId, todoId) {
    const buildTree = (id, visited = new Set()) => {
      if (visited.has(id)) {
        return { id, circular: true };
      }

      visited.add(id);
      const todo = this.findById(agentId, id);

      if (!todo) {
        return null;
      }

      const dependencies = todo.dependencies.map(depId => buildTree(depId, new Set(visited))).filter(Boolean);

      return {
        ...todo,
        dependencies
      };
    };

    return buildTree(todoId);
  }

  static getContextSummary(agentId) {
    const db = getDb();

    const allTodos = this.findAllByAgent(agentId, {});
    const stats = this.getStats(agentId);
    const readyTasks = this.getReadyTasks(agentId);
    const criticalTasks = allTodos.filter(t => t.priority === 'critical' && t.status !== 'completed' && t.status !== 'cancelled');

    const activeTasks = allTodos.filter(t => ['in_progress', 'validating', 'pending_validation'].includes(t.status));

    const todosByProject = {};
    allTodos.forEach(todo => {
      const projectId = todo.project_id || 'unassigned';
      if (!todosByProject[projectId]) {
        todosByProject[projectId] = [];
      }
      todosByProject[projectId].push(todo);
    });

    const allTags = new Set();
    allTodos.forEach(todo => {
      todo.tags.forEach(tag => allTags.add(tag));
    });

    const recentlyCompleted = allTodos
      .filter(t => t.status === 'completed')
      .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at))
      .slice(0, 5);

    const blockedTasks = allTodos.filter(todo => {
      if (todo.status !== 'pending' || todo.dependencies.length === 0) {
        return false;
      }
      return !todo.dependencies.every(depId => {
        const dep = allTodos.find(t => t.id === depId);
        return dep && (dep.status === 'completed' || dep.status === 'cancelled');
      });
    });

    return {
      overview: {
        total: stats.active_tasks || stats.total,
        active: stats.pending + stats.in_progress + (stats.pending_validation || 0) + (stats.validating || 0),
        completed: stats.completed,
        blocked: blockedTasks.length
      },
      focus: {
        critical_count: stats.critical_pending,
        high_count: stats.high_pending,
        ready_to_start: readyTasks.length,
        currently_working_on: activeTasks.map(t => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          progress: t.heartbeat_progress || 0
        }))
      },
      priority_tasks: readyTasks
        .filter(t => t.priority === 'critical' || t.priority === 'high')
        .sort((a, b) => {
          const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        })
        .slice(0, 5)
        .map(t => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          context: t.context
        })),
      blocked: blockedTasks.map(t => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        waiting_on: t.dependencies.map(depId => {
          const dep = allTodos.find(todo => todo.id === depId);
          return dep ? { id: dep.id, title: dep.title, status: dep.status } : null;
        }).filter(Boolean)
      })),
      projects: Object.keys(todosByProject).map(projectId => {
        if (projectId === 'unassigned') {
          return {
            id: 'unassigned',
            name: '未分配',
            todo_count: todosByProject[projectId].length,
            completed: todosByProject[projectId].filter(t => t.status === 'completed').length
          };
        }
        const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
        return {
          id: projectId,
          name: project ? project.name : 'Unknown',
          color: project ? project.color : '#667eea',
          todo_count: todosByProject[projectId].length,
          completed: todosByProject[projectId].filter(t => t.status === 'completed').length
        };
      }),
      tags: Array.from(allTags),
      recently_completed: recentlyCompleted.map(t => ({
        id: t.id,
        title: t.title,
        completed_at: t.completed_at
      })),
      suggestion: this.generateSuggestion(stats, readyTasks, blockedTasks, criticalTasks)
    };
  }

  static generateSuggestion(stats, readyTasks, blockedTasks, criticalTasks) {
    const suggestions = [];

    if (criticalTasks.length > 0) {
      suggestions.push({
        type: 'critical',
        message: `⚠️ 有 ${criticalTasks.length} 个紧急任务需要处理`,
        priority: 1
      });
    }

    if (blockedTasks.length > 0) {
      suggestions.push({
        type: 'blocked',
        message: `🚧 ${blockedTasks.length} 个任务被阻塞，等待依赖任务完成`,
        priority: 2
      });
    }

    if (stats.high_pending > 0) {
      suggestions.push({
        type: 'high_priority',
        message: `📌 有 ${stats.high_pending} 个高优先级任务待处理`,
        priority: 3
      });
    }

    if (readyTasks.length > 0) {
      suggestions.push({
        type: 'ready',
        message: `✨ 有 ${readyTasks.length} 个任务可以立即开始`,
        priority: 4
      });
    }

    if (stats.completed > 0 && stats.pending === 0 && stats.in_progress === 0 && 
        (stats.pending_validation || 0) === 0 && (stats.validating || 0) === 0) {
      suggestions.push({
        type: 'all_done',
        message: `🎉 所有任务已完成！`,
        priority: 5
      });
    }

    return suggestions.sort((a, b) => a.priority - b.priority);
  }

  static updateHeartbeat(agentId, id, heartbeatData) {
    const db = getDb();
    const todo = this.findById(agentId, id);
    if (!todo) return null;

    const updates = ['last_heartbeat = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP'];
    const values = [];

    if (heartbeatData.progress !== undefined) {
      updates.push('heartbeat_progress = ?');
      values.push(heartbeatData.progress);
    }
    if (heartbeatData.step !== undefined) {
      updates.push('heartbeat_step = ?');
      values.push(heartbeatData.step);
    }
    if (heartbeatData.blockers !== undefined) {
      updates.push('heartbeat_blockers = ?');
      values.push(JSON.stringify(heartbeatData.blockers));
    }

    values.push(id, agentId);

    const stmt = db.prepare(`
      UPDATE todos SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(...values);
    const refreshed = this.findById(agentId, id);
    try {
      const JobRunService = require('../services/JobRunService');
      JobRunService.markHeartbeat(agentId, refreshed, { source: 'todo_update_heartbeat' });
    } catch (err) {
      console.error('[Todo] markHeartbeat failed:', err.message);
    }
    return refreshed;
  }

  static recordAttempt(agentId, id, attemptResult) {
    const db = getDb();
    const todo = this.findById(agentId, id);
    if (!todo) return null;

    const logEntry = {
      timestamp: new Date().toISOString(),
      success: attemptResult.success,
      reason: attemptResult.reason || '',
      output: attemptResult.output || ''
    };

    const newLog = [...todo.attempt_log, logEntry];
    const newCount = todo.attempt_count + 1;

    let newStatus = todo.status;
    if (!attemptResult.success && newCount >= todo.max_attempts) {
      newStatus = 'blocked';
    }

    return this.update(agentId, id, {
      attemptCount: newCount,
      attemptLog: newLog,
      status: newStatus,
      ...(newStatus === 'blocked' ? { failureBucket: 'tool_failure' } : {})
    });
  }

  static findSubtasks(agentId, parentId) {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM todos WHERE agent_id = ? AND parent_id = ? ORDER BY position ASC');
    const todos = stmt.all(agentId, parentId);
    return todos.map(hydrateTodoRecord);
  }

  static cancelOrphanChildren(agentId) {
    const db = getDb();
    const orphaned = db.prepare(`
      SELECT t.id, t.title, t.parent_id FROM todos t
      WHERE t.agent_id = ?
        AND t.parent_id IS NOT NULL AND t.parent_id != ''
        AND t.status IN ('blocked', 'in_progress', 'pending', 'validation_failed')
        AND (t.archived IS NULL OR t.archived = 0)
        AND (t.is_template IS NULL OR t.is_template = 0)
    `).all(agentId);

    let cancelled = 0;
    for (const t of orphaned) {
      const parent = db.prepare('SELECT status FROM todos WHERE id = ?').get(t.parent_id);
      if (parent && parent.status === 'completed') {
        db.prepare(`
          UPDATE todos SET status = 'cancelled', updated_at = datetime('now'),
            heartbeat_step = '父任务已完成，自动清理孤儿子任务'
          WHERE id = ?
        `).run(t.id);
        cancelled++;
      }
    }
    return cancelled;
  }

  static checkAndCompleteParent(agentId, childId) {
    const db = getDb();
    const child = this.findById(agentId, childId);
    if (!child || !child.parent_id) return false;

    const parent = this.findById(agentId, child.parent_id);
    if (!parent || parent.status === 'completed') return false;

    const subtasks = this.findSubtasks(agentId, parent.id);
    const allCompleted = subtasks.length > 0 && subtasks.every(t => t.status === 'completed');

    if (allCompleted) {
      this.update(agentId, parent.id, { status: 'completed' });
      console.log(`[Todo] Parent task auto-completed: ${parent.title}`);
      return true;
    }

    return false;
  }

  static findStuckTasks(agentId, maxIdleMinutes = 30) {
    const db = getDb();
    const cutoff = new Date(Date.now() - maxIdleMinutes * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND status = 'in_progress'
        AND (last_heartbeat IS NULL OR last_heartbeat < ?)
    `);
    const todos = stmt.all(agentId, cutoff);
    return todos.map(hydrateTodoRecord);
  }

  /**
   * 查找所有 in_progress 任务（用于动态阈值检测）
   */
  static findAllInProgress(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND status IN ('in_progress', 'validating', 'pending_validation')
    `);
    const todos = stmt.all(agentId);
    return todos.map(hydrateTodoRecord);
  }

  static findProgressStalledTasks(agentId, stallMinutes = 15) {
    const db = getDb();
    const cutoff = new Date(Date.now() - stallMinutes * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND status IN ('in_progress', 'validating', 'pending_validation')
        AND last_heartbeat IS NOT NULL
        AND last_heartbeat < ?
        AND (updated_at IS NULL OR updated_at < ?)
    `);
    const todos = stmt.all(agentId, cutoff, cutoff);
    return todos.map(hydrateTodoRecord);
  }

  // ==================== 多智能体协作方法 ====================

  static assign(agentId, todoId, assignedAgentId, note = '') {
    const db = getDb();
    const todo = this.findById(agentId, todoId);
    if (!todo) throw new Error('Todo not found');

    const stmt = db.prepare(`
      UPDATE todos SET
        assigned_agent_id = ?,
        assignment_note = ?,
        assigned_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(assignedAgentId, note, todoId, agentId);
    return this.findById(agentId, todoId);
  }

  static findAssignedToMe(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE assigned_agent_id = ? AND status != 'completed' AND status != 'cancelled'
      ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        created_at DESC
    `);
    const todos = stmt.all(agentId);
    return todos.map(hydrateTodoRecord);
  }

  static findCreatedByMe(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE origin_agent_id = ?
      ORDER BY created_at DESC
    `);
    const todos = stmt.all(agentId);
    return todos.map(hydrateTodoRecord);
  }

  static transfer(agentId, todoId, newAssignedAgentId, reason = '') {
    const db = getDb();
    const todo = this.findById(agentId, todoId);
    if (!todo) throw new Error('Todo not found');

    const stmt = db.prepare(`
      UPDATE todos SET
        assigned_agent_id = ?,
        transferred_from = ?,
        assignment_note = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(newAssignedAgentId, todo.assigned_agent_id, reason, todoId, agentId);
    return this.findById(agentId, todoId);
  }

  // 归档超过 N 天的 completed/cancelled 任务（soft delete）
  static archiveOldCompleted(agentId, daysOld = 30) {
    const db = getDb();
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      UPDATE todos SET archived = 1, updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ? AND status IN ('completed', 'cancelled')
        AND completed_at < ? AND (archived = 0 OR archived IS NULL)
    `);
    const result = stmt.run(agentId, cutoff);
    return result.changes;
  }

  static cancelStalePending(agentId, hoursOld = 48) {
    const db = getDb();
    const cutoff = new Date(Date.now() - hoursOld * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      UPDATE todos SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE agent_id = ? AND status = 'pending'
        AND created_at < ? AND (parent_id IS NULL OR parent_id = '')
        AND (is_template = 0 OR is_template IS NULL)
    `);
    const result = stmt.run(agentId, cutoff);
    return result.changes;
  }

  // 物理删除已归档的任务（谨慎使用）
  static purgeArchived(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      DELETE FROM todos
      WHERE agent_id = ? AND archived = 1
    `);
    const result = stmt.run(agentId);
    return result.changes;
  }

  // ==================== 定时调度任务方法 ====================

  static findTemplates(agentId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM todos
      WHERE agent_id = ? AND is_template = 1
      ORDER BY next_due_at ASC, created_at DESC
    `);
    const todos = stmt.all(agentId);
    return todos.map(hydrateTodoRecord);
  }

  static findDueTemplates(agentId, referenceTime = new Date(), options = {}) {
    const { reconcile = false } = options;
    const now = coerceDate(referenceTime) || new Date();
    let templates = this.findTemplates(agentId);

    if (reconcile) {
      templates = templates.map(template => this.reconcileTemplateNextDueAt(agentId, template, now));
    }

    return templates.filter(template => {
      const nextDue = coerceDate(template.next_due_at);
      return nextDue && nextDue.getTime() <= now.getTime();
    });
  }

  static reconcileTemplateNextDueAt(agentId, template, referenceTime = new Date()) {
    if (!template || !template.schedule) return template;

    const reference = coerceDate(referenceTime) || new Date();
    if (shouldSkipCrossDayCatchup(template, reference)) {
      const futureNextDue = this.computeNextDueAt(template.schedule, reference);
      if (!futureNextDue) return template;
      if (isSameInstant(template.next_due_at, futureNextDue)) {
        return {
          ...template,
          next_due_at: futureNextDue
        };
      }
      return this.update(agentId, template.id, {
        nextDueAt: futureNextDue
      });
    }

    const baseTime = coerceDate(template.last_spawned_at) || coerceDate(template.created_at) || reference;
    const computedNextDue = this.computeNextDueAt(template.schedule, baseTime);

    if (!computedNextDue) return template;

    if (isSameInstant(template.next_due_at, computedNextDue)) {
      return {
        ...template,
        next_due_at: computedNextDue
      };
    }

    return this.update(agentId, template.id, {
      nextDueAt: computedNextDue
    });
  }

  static spawnFromTemplate(agentId, templateId, options = {}) {
    const db = getDb();
    const template = this.findById(agentId, templateId);
    if (!template) throw new Error('Template not found');
    if (!template.is_template) throw new Error('Task is not a template');

    const { skipDedupe = false, replacesId = null, replaceExisting = false } = options;

    let replacedTask = null;

    if (!skipDedupe && replaceExisting) {
      const activeDup = db.prepare(`
        SELECT id, title, status, priority, created_at FROM todos
        WHERE agent_id = ? AND title = ? AND archived = 0
          AND status NOT IN ('completed', 'cancelled')
          AND id != ?
        LIMIT 1
      `).get(agentId, template.title, templateId);

      if (activeDup) {
        replacedTask = activeDup;
        db.prepare(`
          UPDATE todos SET
            status = 'cancelled',
            archived = 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND agent_id = ?
        `).run(activeDup.id, agentId);

        Context.create(agentId, {
          sessionId: 'scheduler',
          role: 'system',
          content: `[DailyScheduler] 旧任务「${template.title}」(ID: ${activeDup.id}) 被新实例替换，已自动归档`,
          metadata: { type: 'task_replaced', old_task_id: activeDup.id, template_id: templateId }
        });
      }
    }

    const newId = uuidv4();
    const assignedAt = template.assigned_agent_id ? new Date().toISOString() : null;
    const taskCategory = template.task_category || 'general';
    const stmt = db.prepare(`
      INSERT INTO todos (
        id, agent_id, project_id, parent_id, title, description, priority,
        context, tags, dependencies, position,
        acceptance_criteria, criteria_confirmed, max_attempts,
        origin_agent_id, assigned_agent_id, assigned_at, schedule, is_template, status,
        task_category, task_spec, created_at, updated_at,
        transferred_from
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    `);

    stmt.run(
      newId, agentId, template.project_id, templateId,
      template.title, template.description || '', template.priority,
      template.context || '', JSON.stringify(template.tags || []), JSON.stringify(template.dependencies || []), template.position,
      template.acceptance_criteria || '', template.criteria_confirmed ? 1 : 0, template.max_attempts,
      agentId, template.assigned_agent_id || null, assignedAt, null, 0, 'pending',
      taskCategory, template.task_spec ? JSON.stringify(template.task_spec) : null,
      replacedTask ? replacedTask.id : (replacesId || null)
    );

    // Update template: last_spawned_at and next_due_at
    const spawnedAt = new Date();
    const nextDueAt = template.schedule
      ? this.computeNextDueAt(template.schedule, spawnedAt)
      : null;

    const updateStmt = db.prepare(`
      UPDATE todos SET last_spawned_at = ?, next_due_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);
    updateStmt.run(spawnedAt.toISOString(), nextDueAt, templateId, agentId);

    const spawned = this.findById(agentId, newId);
    if (replacedTask) {
      spawned._replacedFrom = replacedTask;
    }
    return spawned;
  }

  static archiveSiblingActiveInstances(agentId, taskId, options = {}) {
    const db = getDb();
    const current = this.findById(agentId, taskId);
    if (!current || !current.parent_id) return [];

    const activeStatuses = options.activeStatuses || ['pending', 'in_progress', 'blocked', 'pending_validation', 'validating'];
    const reason = options.reason || '新实例已接管执行';
    const placeholders = activeStatuses.map(() => '?').join(', ');
    const siblings = db.prepare(`
      SELECT id, title, status, created_at
      FROM todos
      WHERE agent_id = ?
        AND parent_id = ?
        AND id != ?
        AND (archived = 0 OR archived IS NULL)
        AND status IN (${placeholders})
      ORDER BY datetime(created_at) DESC
    `).all(agentId, current.parent_id, taskId, ...activeStatuses);

    if (siblings.length === 0) return [];

    const updateStmt = db.prepare(`
      UPDATE todos
      SET status = 'cancelled',
          archived = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND agent_id = ?
    `);

    for (const sibling of siblings) {
      updateStmt.run(sibling.id, agentId);
    }

    Context.create(agentId, {
      sessionId: 'scheduler',
      role: 'system',
      content: `[TaskCleanup] 任务「${current.title}」接管执行，已自动归档同模板旧实例 ${siblings.length} 个`,
      metadata: {
        type: 'task_cleanup',
        task_id: taskId,
        template_id: current.parent_id,
        archived_task_ids: siblings.map(s => s.id),
        reason
      }
    });

    return siblings.map(sibling => this.findById(agentId, sibling.id)).filter(Boolean);
  }

  static writeReport(agentId, taskId, reportData) {
    const db = getDb();
    const todo = this.findById(agentId, taskId);
    if (!todo) throw new Error('Task not found');

    const { status, description, context, heartbeatProgress, heartbeatStep, heartbeatBlockers } = reportData;

    const updates = [];
    const values = [];

    if (status) {
      updates.push('status = ?');
      values.push(status);
      if (status === 'completed') {
        updates.push('completed_at = CURRENT_TIMESTAMP');
      }
    }

    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }

    if (context !== undefined) {
      updates.push('context = ?');
      values.push(context);
    }

    if (heartbeatProgress !== undefined) {
      updates.push('heartbeat_progress = ?');
      values.push(heartbeatProgress);
    }

    if (heartbeatStep !== undefined) {
      updates.push('heartbeat_step = ?');
      values.push(heartbeatStep);
    }

    if (heartbeatBlockers !== undefined) {
      updates.push('heartbeat_blockers = ?');
      values.push(JSON.stringify(heartbeatBlockers));
    }

    if (updates.length === 0) {
      return this.findById(agentId, taskId);
    }

    updates.push('last_heartbeat = CURRENT_TIMESTAMP', 'updated_at = CURRENT_TIMESTAMP');
    values.push(taskId, agentId);

    const stmt = db.prepare(`
      UPDATE todos SET ${updates.join(', ')}
      WHERE id = ? AND agent_id = ?
    `);
    stmt.run(...values);
    return this.findById(agentId, taskId);
  }

  static findPendingByTemplate(agentId, templateId) {
    const db = getDb();
    const stmt = db.prepare(
      'SELECT * FROM todos WHERE agent_id = ? AND parent_id = ? AND status = ?'
    );
    const todos = stmt.all(agentId, templateId, 'pending');
    return todos.map(hydrateTodoRecord);
  }

  static computeNextDueAt(schedule, fromTime) {
    if (!schedule) return null;

    const from = coerceDate(fromTime);
    if (!from) return null;

    // daily: next occurrence is exactly 24h later
    if (schedule === 'daily') {
      const next = new Date(from);
      next.setDate(next.getDate() + 1);
      return next.toISOString();
    }

    // weekly:mon,tue,wed — comma-separated day abbreviations
    if (schedule.startsWith('weekly:')) {
      const daysPart = schedule.slice(7);
      const dayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const targetDays = daysPart.split(',').map(d => dayMap[d.trim().toLowerCase()]).filter(v => v !== undefined);
      if (targetDays.length === 0) return null;

      const next = new Date(from);
      // Start checking from tomorrow
      for (let i = 1; i <= 8; i++) {
        next.setDate(next.getDate() + 1);
        if (targetDays.includes(next.getDay())) {
          return next.toISOString();
        }
      }
      return null;
    }

    // cron: expression — 使用当前机器本地时区按标准 5 段 cron 解析。
    const cronExpr = schedule.startsWith('cron:') ? schedule.slice(5).trim() : schedule;
    const nextCronDue = findNextCronOccurrence(cronExpr, from);
    if (nextCronDue) {
      return nextCronDue;
    }

    return null;
  }
}

module.exports = Todo;
