const Todo = require('../models/Todo');
const Context = require('../models/Context');
const { getDb } = require('../db');

class TaskReportService {
  static async generateReport(agentId, taskId) {
    const task = Todo.findById(agentId, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const basicInfo = this.extractBasicInfo(task);
    const executionRecords = await this.extractExecutionRecords(agentId, taskId, task);
    const validationRecords = await this.extractValidationRecords(agentId, taskId, task);
    const timeline = await this.buildTimeline(agentId, taskId, task);

    return {
      generatedAt: new Date().toISOString(),
      taskId,
      agentId,
      ...basicInfo,
      execution: executionRecords,
      validation: validationRecords,
      timeline
    };
  }

  static extractBasicInfo(task) {
    const createdAt = new Date(task.created_at);
    const completedAt = task.completed_at ? new Date(task.completed_at) : new Date();
    const totalDuration = task.completed_at
      ? Math.round((completedAt - createdAt) / 1000 / 60)
      : null;

    return {
      basic: {
        id: task.id,
        title: task.title,
        description: task.description || null,
        status: task.status,
        priority: task.priority || 'medium',
        createdAt: task.created_at,
        completedAt: task.completed_at,
        totalDurationMinutes: totalDuration,
        originAgentId: task.origin_agent_id,
        assignedAgentId: task.assigned_agent_id,
        tags: task.tags || [],
        acceptanceCriteria: task.acceptance_criteria || null,
        criteriaConfirmed: task.criteria_confirmed === 1
      }
    };
  }

  static async extractExecutionRecords(agentId, taskId, task) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM contexts
      WHERE agent_id = ? AND metadata LIKE ?
      ORDER BY created_at ASC
    `);

    const rawContexts = stmt.all(agentId, `%${taskId}%`);
    const contexts = rawContexts.map(ctx => ({
      ...ctx,
      metadata: JSON.parse(ctx.metadata || '{}')
    }));

    const driveRequests = contexts.filter(c =>
      c.metadata && c.metadata.type === 'drive_request'
    );

    const commandExecs = contexts.filter(c =>
      c.metadata && c.metadata.type === 'command_exec'
    );

    const progressReports = contexts.filter(c =>
      c.metadata && c.metadata.type === 'progress_report'
    );

    const llmReplies = contexts.filter(c =>
      c.metadata && c.metadata.type === 'llm_reply'
    );

    return {
      totalDrives: driveRequests.length,
      totalCommandExecutions: commandExecs.length,
      totalProgressReports: progressReports.length,
      totalLLMReplies: llmReplies.length,
      driveHistory: driveRequests.map(d => ({
        timestamp: d.created_at,
        attempt: d.metadata?.attempt || null
      })),
      commandHistory: commandExecs.map(c => {
        let commands = [];
        try {
          const match = c.content.match(/\[(\d+)\]\s*[✅❌]\s*(.+)/g);
          if (match) {
            commands = match.map(m => {
              const parts = m.match(/\[(\d+)\]\s*([✅❌])\s*(.+)/);
              return {
                index: parseInt(parts[1]),
                success: parts[2] === '✅',
                command: parts[3].trim()
              };
            });
          }
        } catch (e) {}
        return {
          timestamp: c.created_at,
          commands
        };
      }),
      attemptCount: task.attempt_count || 0,
      maxAttempts: task.max_attempts || 3
    };
  }

  static async extractValidationRecords(agentId, taskId, task) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM contexts
      WHERE agent_id = ? AND metadata LIKE ?
      ORDER BY created_at ASC
    `);

    const rawContexts = stmt.all(agentId, `%${taskId}%`);
    const contexts = rawContexts.map(ctx => ({
      ...ctx,
      metadata: JSON.parse(ctx.metadata || '{}')
    }));

    const validationDispatches = contexts.filter(c =>
      c.metadata && c.metadata.type === 'validation_dispatch'
    );

    const validationReports = contexts.filter(c =>
      c.metadata && c.metadata.type === 'third_party_validation_report'
    );

    const autoValidationTriggers = contexts.filter(c =>
      c.metadata && c.metadata.type === 'auto_validation_trigger'
    );

    const records = [];

    for (const vr of validationReports) {
      try {
        const passMatch = vr.content.match(/✅|❌/);
        const scoreMatch = vr.content.match(/评分\s*(\d+)/);
        const reasonMatch = vr.content.match(/原因[：:]\s*(.+?)(?=\n|$)/);
        const feedbackMatch = vr.content.match(/反馈[：:]\s*(.+?)(?=\n|$)/);

        records.push({
          timestamp: vr.created_at,
          validatorAgentId: vr.metadata?.validator || null,
          pass: vr.content.includes('✅'),
          score: scoreMatch ? parseInt(scoreMatch[1]) : null,
          reason: reasonMatch ? reasonMatch[1].trim() : null,
          feedback: feedbackMatch ? feedbackMatch[1].trim() : null
        });
      } catch (e) {}
    }

    return {
      totalValidationAttempts: validationDispatches.length + autoValidationTriggers.length,
      validationReportCount: validationReports.length,
      finalResult: task.validation_report
        ? JSON.parse(task.validation_report)
        : null,
      validatedBy: task.validated_by || null,
      validationCount: task.validation_count || 0,
      records
    };
  }

  static async buildTimeline(agentId, taskId, task) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT * FROM contexts
      WHERE agent_id = ? AND metadata LIKE ?
      ORDER BY created_at ASC
    `);

    const rawContexts = stmt.all(agentId, `%${taskId}%`);
    const contexts = rawContexts.map(ctx => ({
      ...ctx,
      metadata: JSON.parse(ctx.metadata || '{}')
    }));

    const events = [];

    events.push({
      timestamp: task.created_at,
      type: 'task_created',
      description: '任务创建',
      data: { originAgentId: task.origin_agent_id }
    });

    if (task.assigned_agent_id && task.assigned_agent_id !== task.origin_agent_id) {
      events.push({
        timestamp: task.assigned_at || task.created_at,
        type: 'task_assigned',
        description: '任务指派',
        data: { assignedAgentId: task.assigned_agent_id }
      });
    }

    for (const ctx of contexts) {
      if (!ctx.metadata || !ctx.metadata.type) continue;

      switch (ctx.metadata.type) {
        case 'drive_request':
          events.push({
            timestamp: ctx.created_at,
            type: 'drive_execution',
            description: '驱动执行',
            data: { attempt: ctx.metadata.attempt }
          });
          break;
        case 'task_start':
          events.push({
            timestamp: ctx.created_at,
            type: 'task_started',
            description: '任务开始执行',
            data: {}
          });
          break;
        case 'progress_report':
          const progressMatch = ctx.content.match(/进度[：:]\s*(\d+)%/);
          const stepMatch = ctx.content.match(/步骤[：:]\s*(.+?)(?=\n|$)/);
          events.push({
            timestamp: ctx.created_at,
            type: 'progress_update',
            description: '进度更新',
            data: {
              progress: progressMatch ? parseInt(progressMatch[1]) : null,
              step: stepMatch ? stepMatch[1].trim() : null
            }
          });
          break;
        case 'command_exec':
          events.push({
            timestamp: ctx.created_at,
            type: 'command_execution',
            description: '命令执行',
            data: { commandsCount: ctx.metadata.commands_count }
          });
          break;
        case 'validation_dispatch':
          events.push({
            timestamp: ctx.created_at,
            type: 'validation_dispatched',
            description: '验证任务派发',
            data: { validationTaskId: ctx.metadata.validation_task_id }
          });
          break;
        case 'third_party_validation_report':
          events.push({
            timestamp: ctx.created_at,
            type: 'validation_received',
            description: '验证报告接收',
            data: {
              validator: ctx.metadata.validator,
              pass: ctx.metadata.pass,
              score: ctx.metadata.score
            }
          });
          break;
        case 'task_completion_proposal':
          events.push({
            timestamp: ctx.created_at,
            type: 'completion_proposed',
            description: '申请完成',
            data: {}
          });
          break;
        case 'task_force_completion':
          events.push({
            timestamp: ctx.created_at,
            type: 'force_completed',
            description: '强制完成',
            data: {}
          });
          break;
      }
    }

    if (task.completed_at) {
      events.push({
        timestamp: task.completed_at,
        type: 'task_completed',
        description: '任务完成',
        data: { finalStatus: task.status }
      });
    }

    return events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  static formatMarkdownReport(report) {
    const { basic, execution, validation, timeline, generatedAt } = report;

    let md = `# 任务流程报告\n\n`;
    md += `> 生成时间: ${new Date(generatedAt).toLocaleString('zh-CN')}\n\n`;

    md += `## 基本信息\n\n`;
    md += `| 字段 | 值 |\n`;
    md += `|------|-----|\n`;
    md += `| 任务 ID | \`${basic.id}\` |\n`;
    md += `| 标题 | ${basic.title} |\n`;
    md += `| 状态 | ${this.statusEmoji(basic.status)} ${basic.status} |\n`;
    md += `| 优先级 | ${basic.priority} |\n`;
    md += `| 创建时间 | ${basic.createdAt} |\n`;
    md += `| 完成时间 | ${basic.completedAt || '-'} |\n`;
    md += `| 总耗时 | ${basic.totalDurationMinutes ? `${basic.totalDurationMinutes} 分钟` : '-'} |\n`;
    md += `| 创建者 | ${basic.originAgentId} |\n`;
    md += `| 执行者 | ${basic.assignedAgentId || basic.originAgentId} |\n`;
    md += `| 验收标准 | ${basic.acceptanceCriteria || '未设置'} |\n`;
    md += `| 标签 | ${basic.tags.join(', ') || '无'} |\n\n`;

    md += `## 执行统计\n\n`;
    md += `| 指标 | 数值 |\n`;
    md += `|------|------|\n`;
    md += `| 驱动次数 | ${execution.totalDrives} |\n`;
    md += `| 命令执行次数 | ${execution.totalCommandExecutions} |\n`;
    md += `| 进度报告次数 | ${execution.totalProgressReports} |\n`;
    md += `| LLM 回复次数 | ${execution.totalLLMReplies} |\n`;
    md += `| 尝试次数 | ${execution.attemptCount} / ${execution.maxAttempts} |\n\n`;

    if (validation.records.length > 0) {
      md += `## 验证记录\n\n`;
      md += `| 验证者 | 结果 | 评分 | 时间 | 原因 |\n`;
      md += `|--------|------|------|------|------|\n`;
      for (const record of validation.records) {
        md += `| ${record.validatorAgentId || '-'} | ${record.pass ? '✅ 通过' : '❌ 失败'} | ${record.score || '-'} | ${record.timestamp} | ${record.reason || '-'} |\n`;
      }
      md += `\n`;
      md += `- 验证次数: ${validation.validationCount}\n`;
      md += `- 最终验证者: ${validation.validatedBy || '-'}\n\n`;
    }

    if (timeline.length > 0) {
      md += `## 时间线\n\n`;
      md += `| 时间 | 事件 | 说明 |\n`;
      md += `|------|------|------|\n`;
      for (const event of timeline) {
        md += `| ${event.timestamp} | ${this.eventTypeEmoji(event.type)} ${event.type} | ${event.description} |\n`;
      }
      md += `\n`;
    }

    if (execution.commandHistory.length > 0) {
      md += `## 命令执行历史\n\n`;
      for (const entry of execution.commandHistory) {
        if (entry.commands.length > 0) {
          md += `**${entry.timestamp}**\n`;
          for (const cmd of entry.commands) {
            md += `- ${cmd.success ? '✅' : '❌'} \`${cmd.command}\`\n`;
          }
          md += `\n`;
        }
      }
    }

    return md;
  }

  static statusEmoji(status) {
    const map = {
      pending: '⏳',
      in_progress: '🔄',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
      blocked: '🔴',
      validation_failed: '⚠️',
      pending_validation: '📋'
    };
    return map[status] || '❓';
  }

  static eventTypeEmoji(type) {
    const map = {
      task_created: '🆕',
      task_assigned: '📌',
      task_started: '▶️',
      drive_execution: '🚀',
      progress_update: '📊',
      command_execution: '💻',
      validation_dispatched: '📋',
      validation_received: '📨',
      completion_proposed: '✅',
      force_completed: '⚡',
      task_completed: '🎉',
      stalled: '⚠️'
    };
    return map[type] || '📌';
  }
}

module.exports = TaskReportService;