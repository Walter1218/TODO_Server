const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db');
const Todo = require('../models/Todo');
const Agent = require('../models/Agent');

const PLAN_STATUSES = {
  NOT_REQUIRED: 'not_required',
  DRAFT: 'draft',
  APPROVED: 'approved',
  NEEDS_REVISION: 'needs_revision',
  REJECTED: 'rejected',
  COMPLETED: 'completed'
};

const STEP_STATUSES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked'
};

const EXECUTION_STATES = {
  IDLE: 'idle',
  READY: 'ready',
  EXECUTING: 'executing',
  WAITING_VALIDATION: 'waiting_validation',
  BLOCKED: 'blocked',
  NEEDS_REVISION: 'needs_revision',
  COMPLETED: 'completed'
};

const COMPLEX_TITLE_HINTS = /(修复|排查|同步|脚本|数据|巡检|分析|优化|回填|核验|验证|迁移|部署)/i;
const REDLINE_PATTERNS = [
  { pattern: /\brm\s+-rf\b/i, reason: '检测到高危删除命令' },
  { pattern: /\bdrop\s+table\b/i, reason: '检测到高危删表语句' },
  { pattern: /\btruncate\s+table\b/i, reason: '检测到高危清表语句' },
  { pattern: /(生产|prod|production|线上).{0,12}(数据库|db|duckdb|mysql|sqlite)/i, reason: '检测到可能触达生产数据的描述' }
];

class TaskPlanService {
  static isDefaultAgent(agent) {
    const identity = `${agent?.id || ''} ${agent?.name || ''}`.toLowerCase();
    return identity.includes('default');
  }

  static shouldRequirePlan(task, agent = null) {
    if (!task || task.is_template || task.archived) return false;
    if ((task.title || '').startsWith('[验证]')) return false;
    if ((task.title || '').startsWith('[修复]')) return false;
    if (task.requires_plan) return true;

    let score = 0;
    const combined = `${task.title || ''}\n${task.description || ''}\n${task.acceptance_criteria || ''}`;
    const isDefaultAgent = this.isDefaultAgent(agent);

    if (isDefaultAgent) score += 1;
    if (task.task_spec) score += 2;
    if (['script', 'code_change', 'inspection'].includes(task.task_category)) score += 1;
    if ((task.description || '').length >= 120) score += 1;
    if ((task.acceptance_criteria || '').length >= 80 || String(task.acceptance_criteria || '').includes('\n')) score += 1;
    if (COMPLEX_TITLE_HINTS.test(combined)) score += 1;

    return isDefaultAgent ? score >= 2 : score >= 3;
  }

  static _safeJson(value) {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      return {};
    }
  }

  static _summarizeTask(task) {
    const bits = [];
    if (task.task_category) bits.push(`任务类型=${task.task_category}`);
    if (task.task_spec) bits.push('携带结构化 task_spec');
    if (task.acceptance_criteria) bits.push(`验收标准=${String(task.acceptance_criteria).slice(0, 120)}`);
    return bits.join('；');
  }

  static _buildPlan(task) {
    const taskSpecSummary = task.task_spec
      ? `结构化约束：${JSON.stringify(task.task_spec).slice(0, 400)}`
      : '结构化约束：无';
    const acceptance = task.acceptance_criteria
      ? `验收要求：${String(task.acceptance_criteria).slice(0, 300)}`
      : '验收要求：提交可复核的结果摘要和证据。';

    const steps = [
      {
        stepKey: 'inspect',
        title: 'Inspect',
        instruction: [
          '先确认目标、输入输出、依赖和当前阻塞，只做读取、检查和环境确认。',
          taskSpecSummary,
          acceptance,
          '本步骤不允许直接宣告完成。'
        ].join('\n')
      },
      {
        stepKey: 'execute',
        title: 'Execute',
        instruction: [
          '基于 inspect 结果执行最小必要操作，优先真实推进任务而不是重复规划。',
          '执行中持续更新进度；如果发现阻塞，明确记录阻塞原因和缺失依赖。',
          '只有在结果已满足验收要求时，才允许进入待验证状态。'
        ].join('\n')
      },
      {
        stepKey: 'verify',
        title: 'Verify',
        instruction: [
          '核对 completion_report、validationEvidence 与任务验收标准。',
          '等待验证闭环；若验证失败，回到修订态并记录需要补充的证据或修复点。'
        ].join('\n')
      }
    ];

    return {
      summary: `复杂任务强制计划：${task.title}。${this._summarizeTask(task)}`,
      steps,
      metadata: {
        generated_by: 'system_rule',
        low_token_mode: true
      }
    };
  }

  static _reviewPlan(task, plan) {
    const scanText = `${task.title || ''}\n${task.description || ''}\n${plan.summary || ''}\n${plan.steps.map(step => step.instruction).join('\n')}`;
    const redlines = REDLINE_PATTERNS
      .filter(rule => rule.pattern.test(scanText))
      .map(rule => rule.reason);

    if (redlines.length > 0) {
      return {
        approved: false,
        status: PLAN_STATUSES.NEEDS_REVISION,
        reviewNotes: `计划触发安全红线：${redlines.join('；')}`,
        redlines
      };
    }

    return {
      approved: true,
      status: PLAN_STATUSES.APPROVED,
      reviewNotes: '规则审查通过，允许按 inspect -> execute -> verify 推进。',
      redlines: []
    };
  }

  static createEvent(agentId, taskId, eventType, details = {}, options = {}) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO task_events (
        id, agent_id, task_id, plan_id, step_id, event_type, event_status, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      uuidv4(),
      agentId,
      taskId,
      options.planId || null,
      options.stepId || null,
      eventType,
      options.eventStatus || 'info',
      JSON.stringify(details || {})
    );
  }

  static getLatestPlan(agentId, taskId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM task_plans
      WHERE agent_id = ? AND task_id = ?
      ORDER BY revision DESC, created_at DESC
      LIMIT 1
    `).get(agentId, taskId) || null;
  }

  static getPlanSteps(planId) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM task_plan_steps
      WHERE plan_id = ?
      ORDER BY step_order ASC
    `).all(planId);
  }

  static getCurrentStep(agentId, task) {
    const db = getDb();
    const currentTask = task?.id ? (Todo.findById(agentId, task.id) || task) : task;
    if (!currentTask?.current_plan_id) return null;
    if (currentTask.current_step_id) {
      return db.prepare('SELECT * FROM task_plan_steps WHERE id = ?').get(currentTask.current_step_id) || null;
    }
    return db.prepare(`
      SELECT * FROM task_plan_steps
      WHERE plan_id = ? AND status != ?
      ORDER BY step_order ASC
      LIMIT 1
    `).get(currentTask.current_plan_id, STEP_STATUSES.COMPLETED) || null;
  }

  static _updateStep(stepId, updates = {}) {
    const db = getDb();
    const sets = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(updates, 'status')) {
      sets.push('status = ?');
      values.push(updates.status);
      if (updates.status === STEP_STATUSES.COMPLETED) {
        sets.push('completed_at = CURRENT_TIMESTAMP');
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'completionNotes')) {
      sets.push('completion_notes = ?');
      values.push(updates.completionNotes || '');
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'metadata')) {
      sets.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata || {}));
    }

    if (sets.length === 0) return;
    sets.push('updated_at = CURRENT_TIMESTAMP');
    values.push(stepId);
    db.prepare(`
      UPDATE task_plan_steps
      SET ${sets.join(', ')}
      WHERE id = ?
    `).run(...values);
  }

  static _setCurrentStep(agentId, taskId, step, executionState) {
    Todo.update(agentId, taskId, {
      currentStepId: step?.id || null,
      executionState,
      lastActionAt: new Date().toISOString()
    });
  }

  static _approvePlan(agentId, task, planId, review) {
    const db = getDb();
    db.prepare(`
      UPDATE task_plans
      SET status = ?, review_notes = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(review.status, review.reviewNotes, planId);

    const steps = this.getPlanSteps(planId);
    const firstStep = steps[0] || null;
    if (firstStep) {
      this._updateStep(firstStep.id, { status: STEP_STATUSES.IN_PROGRESS });
    }

    Todo.update(agentId, task.id, {
      requiresPlan: true,
      planStatus: review.status,
      currentPlanId: planId,
      currentStepId: firstStep?.id || null,
      executionState: EXECUTION_STATES.READY,
      lastActionAt: new Date().toISOString()
    });

    this.createEvent(agentId, task.id, 'plan_approved', {
      review_notes: review.reviewNotes
    }, { planId, stepId: firstStep?.id || null });
  }

  static _rejectPlan(agentId, task, planId, review) {
    const db = getDb();
    db.prepare(`
      UPDATE task_plans
      SET status = ?, review_notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(review.status, review.reviewNotes, planId);

    Todo.update(agentId, task.id, {
      requiresPlan: true,
      planStatus: review.status,
      currentPlanId: planId,
      status: 'blocked',
      executionState: EXECUTION_STATES.NEEDS_REVISION,
      heartbeatStep: `⛔ 计划未通过规则审查：${review.reviewNotes}`,
      lastActionAt: new Date().toISOString()
    });

    this.createEvent(agentId, task.id, 'plan_rejected', {
      review_notes: review.reviewNotes,
      redlines: review.redlines || []
    }, { planId, eventStatus: 'warning' });
  }

  static ensureExecutablePlan(agentId, task) {
    const agent = Agent.findById(agentId);
    const freshTask = Todo.findById(agentId, task.id) || task;

    if (!this.shouldRequirePlan(freshTask, agent)) {
      if (freshTask.requires_plan || freshTask.plan_status !== PLAN_STATUSES.NOT_REQUIRED) {
        Todo.update(agentId, freshTask.id, {
          requiresPlan: false,
          planStatus: PLAN_STATUSES.NOT_REQUIRED,
          executionState: freshTask.status === 'completed' ? EXECUTION_STATES.COMPLETED : EXECUTION_STATES.IDLE
        });
      }
      return {
        required: false,
        approved: true,
        task: Todo.findById(agentId, freshTask.id) || freshTask
      };
    }

    let plan = this.getLatestPlan(agentId, freshTask.id);
    if (!plan) {
      const db = getDb();
      const builtPlan = this._buildPlan(freshTask);
      const revision = 1;
      const planId = uuidv4();
      db.prepare(`
        INSERT INTO task_plans (
          id, agent_id, task_id, revision, status, source, summary, review_notes, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        planId,
        agentId,
        freshTask.id,
        revision,
        PLAN_STATUSES.DRAFT,
        'system_rule',
        builtPlan.summary,
        '',
        JSON.stringify(builtPlan.metadata || {})
      );

      const stepStmt = db.prepare(`
        INSERT INTO task_plan_steps (
          id, plan_id, task_id, step_key, step_order, title, instruction, status, completion_notes, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      builtPlan.steps.forEach((step, index) => {
        stepStmt.run(
          uuidv4(),
          planId,
          freshTask.id,
          step.stepKey,
          index + 1,
          step.title,
          step.instruction,
          STEP_STATUSES.PENDING,
          '',
          JSON.stringify({ generated_by: 'system_rule' })
        );
      });

      Todo.update(agentId, freshTask.id, {
        requiresPlan: true,
        planStatus: PLAN_STATUSES.DRAFT,
        currentPlanId: planId,
        executionState: EXECUTION_STATES.READY,
        lastActionAt: new Date().toISOString()
      });
      this.createEvent(agentId, freshTask.id, 'plan_created', {
        source: 'system_rule',
        summary: builtPlan.summary
      }, { planId });
      plan = this.getLatestPlan(agentId, freshTask.id);
    }

    if (plan.status === PLAN_STATUSES.APPROVED || plan.status === PLAN_STATUSES.COMPLETED) {
      if (freshTask.current_plan_id !== plan.id) {
        const currentStep = this.getCurrentStep(agentId, {
          ...freshTask,
          current_plan_id: plan.id,
          current_step_id: freshTask.current_step_id
        });
        Todo.update(agentId, freshTask.id, {
          requiresPlan: true,
          planStatus: plan.status,
          currentPlanId: plan.id,
          currentStepId: currentStep?.id || freshTask.current_step_id || null,
          executionState: plan.status === PLAN_STATUSES.COMPLETED ? EXECUTION_STATES.COMPLETED : freshTask.execution_state || EXECUTION_STATES.READY
        });
      }
      return {
        required: true,
        approved: true,
        task: Todo.findById(agentId, freshTask.id) || freshTask,
        plan,
        step: this.getCurrentStep(agentId, Todo.findById(agentId, freshTask.id) || freshTask)
      };
    }

    if (plan.status === PLAN_STATUSES.NEEDS_REVISION || plan.status === PLAN_STATUSES.REJECTED) {
      return {
        required: true,
        approved: false,
        reason: 'plan_review_blocked',
        task: Todo.findById(agentId, freshTask.id) || freshTask,
        plan,
        step: this.getCurrentStep(agentId, Todo.findById(agentId, freshTask.id) || freshTask)
      };
    }

    const review = this._reviewPlan(freshTask, {
      summary: plan.summary,
      steps: this.getPlanSteps(plan.id)
    });
    if (review.approved) {
      this._approvePlan(agentId, freshTask, plan.id, review);
    } else {
      this._rejectPlan(agentId, freshTask, plan.id, review);
    }

    const updatedTask = Todo.findById(agentId, freshTask.id) || freshTask;
    return {
      required: true,
      approved: review.approved,
      reason: review.approved ? null : 'plan_review_blocked',
      task: updatedTask,
      plan: this.getLatestPlan(agentId, freshTask.id),
      step: this.getCurrentStep(agentId, updatedTask),
      review
    };
  }

  static completeInspectStep(agentId, task) {
    const freshTask = Todo.findById(agentId, task.id) || task;
    const currentStep = this.getCurrentStep(agentId, freshTask);
    if (!currentStep || currentStep.step_key !== 'inspect') {
      return { advanced: false, task: freshTask, step: currentStep };
    }

    this._updateStep(currentStep.id, {
      status: STEP_STATUSES.COMPLETED,
      completionNotes: '系统已完成 inspect 门禁检查，转入 execute。'
    });

    const nextStep = getDb().prepare(`
      SELECT * FROM task_plan_steps
      WHERE plan_id = ? AND step_order > ?
      ORDER BY step_order ASC
      LIMIT 1
    `).get(currentStep.plan_id, currentStep.step_order);

    if (nextStep) {
      this._updateStep(nextStep.id, { status: STEP_STATUSES.IN_PROGRESS });
    }
    this._setCurrentStep(agentId, freshTask.id, nextStep, EXECUTION_STATES.READY);
    Todo.update(agentId, freshTask.id, {
      heartbeatStep: '计划步骤 inspect 已完成，进入 execute',
      heartbeatBlockers: []
    });
    this.createEvent(agentId, freshTask.id, 'step_completed', {
      step_key: currentStep.step_key,
      next_step_key: nextStep?.step_key || null
    }, { planId: currentStep.plan_id, stepId: currentStep.id });

    return {
      advanced: true,
      task: Todo.findById(agentId, freshTask.id) || freshTask,
      step: nextStep || null
    };
  }

  static buildExecutionOverlay(step) {
    if (!step) return '';
    return [
      `当前强制步骤: ${step.step_key}`,
      `步骤标题: ${step.title}`,
      `步骤说明: ${step.instruction}`,
      step.step_key === 'execute'
        ? '要求: 直接推进执行，不要重新规划；仅在满足验收标准时才进入待验证。'
        : '要求: 仅执行当前步骤。'
    ].join('\n');
  }

  static markExecuteStarted(agentId, task) {
    const freshTask = Todo.findById(agentId, task.id) || task;
    const currentStep = this.getCurrentStep(agentId, freshTask);
    if (!currentStep || currentStep.step_key !== 'execute') return currentStep;
    if (currentStep.status !== STEP_STATUSES.IN_PROGRESS) {
      this._updateStep(currentStep.id, { status: STEP_STATUSES.IN_PROGRESS });
    }
    this._setCurrentStep(agentId, freshTask.id, currentStep, EXECUTION_STATES.EXECUTING);
    this.createEvent(agentId, freshTask.id, 'step_started', {
      step_key: currentStep.step_key
    }, { planId: currentStep.plan_id, stepId: currentStep.id });
    return this.getCurrentStep(agentId, freshTask);
  }

  static syncTaskExecution(agentId, task) {
    const freshTask = Todo.findById(agentId, task.id) || task;
    if (!freshTask?.requires_plan || !freshTask.current_plan_id) {
      return { task: freshTask, step: null };
    }

    const currentStep = this.getCurrentStep(agentId, freshTask);
    if (!currentStep) {
      if (freshTask.status === 'completed') {
        Todo.update(agentId, freshTask.id, {
          planStatus: PLAN_STATUSES.COMPLETED,
          executionState: EXECUTION_STATES.COMPLETED
        });
      }
      return { task: Todo.findById(agentId, freshTask.id) || freshTask, step: null };
    }

    if (freshTask.status === 'blocked') {
      this._updateStep(currentStep.id, {
        status: STEP_STATUSES.BLOCKED,
        completionNotes: '任务被阻塞，等待修订或人工介入。'
      });
      Todo.update(agentId, freshTask.id, {
        planStatus: PLAN_STATUSES.NEEDS_REVISION,
        executionState: EXECUTION_STATES.BLOCKED,
        lastActionAt: new Date().toISOString()
      });
      this.createEvent(agentId, freshTask.id, 'revision_requested', {
        reason: 'task_blocked',
        step_key: currentStep.step_key
      }, { planId: currentStep.plan_id, stepId: currentStep.id, eventStatus: 'warning' });
      return {
        task: Todo.findById(agentId, freshTask.id) || freshTask,
        step: this.getCurrentStep(agentId, freshTask)
      };
    }

    if (currentStep.step_key === 'execute' && ['pending_validation', 'validating', 'completed'].includes(freshTask.status)) {
      this._updateStep(currentStep.id, {
        status: STEP_STATUSES.COMPLETED,
        completionNotes: '执行步骤已结束，进入 verify。'
      });
      const verifyStep = getDb().prepare(`
        SELECT * FROM task_plan_steps
        WHERE plan_id = ? AND step_order > ?
        ORDER BY step_order ASC
        LIMIT 1
      `).get(currentStep.plan_id, currentStep.step_order);
      if (verifyStep) {
        this._updateStep(verifyStep.id, { status: STEP_STATUSES.IN_PROGRESS });
      }
      this._setCurrentStep(
        agentId,
        freshTask.id,
        verifyStep,
        freshTask.status === 'completed' ? EXECUTION_STATES.COMPLETED : EXECUTION_STATES.WAITING_VALIDATION
      );
      this.createEvent(agentId, freshTask.id, 'step_completed', {
        step_key: currentStep.step_key,
        next_step_key: verifyStep?.step_key || null,
        task_status: freshTask.status
      }, { planId: currentStep.plan_id, stepId: currentStep.id });
      return {
        task: Todo.findById(agentId, freshTask.id) || freshTask,
        step: verifyStep
      };
    }

    const latestTask = Todo.findById(agentId, freshTask.id) || freshTask;
    const latestStep = this.getCurrentStep(agentId, latestTask);
    if (latestStep?.step_key === 'verify') {
      if (latestTask.status === 'completed') {
        this._updateStep(latestStep.id, {
          status: STEP_STATUSES.COMPLETED,
          completionNotes: '验证闭环完成。'
        });
        Todo.update(agentId, latestTask.id, {
          planStatus: PLAN_STATUSES.COMPLETED,
          executionState: EXECUTION_STATES.COMPLETED,
          currentStepId: null,
          lastActionAt: new Date().toISOString()
        });
        getDb().prepare(`
          UPDATE task_plans
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(PLAN_STATUSES.COMPLETED, latestStep.plan_id);
        this.createEvent(agentId, latestTask.id, 'plan_completed', {
          task_status: latestTask.status
        }, { planId: latestStep.plan_id, stepId: latestStep.id });
      } else if (latestTask.status === 'validation_failed') {
        Todo.update(agentId, latestTask.id, {
          planStatus: PLAN_STATUSES.NEEDS_REVISION,
          executionState: EXECUTION_STATES.NEEDS_REVISION,
          lastActionAt: new Date().toISOString()
        });
        this.createEvent(agentId, latestTask.id, 'revision_requested', {
          reason: 'validation_failed',
          step_key: latestStep.step_key
        }, { planId: latestStep.plan_id, stepId: latestStep.id, eventStatus: 'warning' });
      } else if (['pending_validation', 'validating'].includes(latestTask.status)) {
        Todo.update(agentId, latestTask.id, {
          executionState: EXECUTION_STATES.WAITING_VALIDATION,
          lastActionAt: new Date().toISOString()
        });
      }
    }

    return {
      task: Todo.findById(agentId, freshTask.id) || freshTask,
      step: this.getCurrentStep(agentId, freshTask)
    };
  }

  static rolloutAgentTasks(agentId) {
    const tasks = Todo.findAllByAgent(agentId, { includeArchived: false, limit: 5000 });
    let planned = 0;
    for (const task of tasks) {
      if (!['pending', 'in_progress', 'blocked', 'pending_validation', 'validation_failed', 'validating'].includes(task.status)) {
        continue;
      }
      const result = this.ensureExecutablePlan(agentId, task);
      if (result.required) planned++;
      this.syncTaskExecution(agentId, result.task || task);
    }
    return { scanned: tasks.length, planned };
  }
}

TaskPlanService.PLAN_STATUSES = PLAN_STATUSES;
TaskPlanService.EXECUTION_STATES = EXECUTION_STATES;
TaskPlanService.STEP_STATUSES = STEP_STATUSES;

module.exports = TaskPlanService;
