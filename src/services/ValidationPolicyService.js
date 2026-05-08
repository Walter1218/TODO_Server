const DataTaskValidationService = require('./DataTaskValidationService');
const CompletionReportBuilder = require('./CompletionReportBuilder');

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function collectSectionItems(report, labels) {
  const sections = Array.isArray(report?.sections) ? report.sections : [];
  const set = new Set(labels);
  return sections
    .filter(section => set.has(section.label))
    .flatMap(section => Array.isArray(section.items) ? section.items : []);
}

function hasCriticalFailureText(text) {
  const lower = String(text || '').toLowerCase();
  return ['失败', 'error', 'critical', 'not found', '缺失严重', '中断', '未完成'].some(token => lower.includes(token));
}

class ValidationPolicyService {
  static inferPolicy(task, report) {
    const reportType = report?.type || '';
    const category = task.task_category || '';
    const combined = `${task.title || ''} ${task.description || ''}`.toLowerCase();

    if (reportType === 'inspection' || category === 'inspection') return 'inspection';
    if (combined.includes('backup') || combined.includes('备份')) return 'backup';
    if (reportType === 'code_change' || category === 'code_change') return 'code_change';
    if (reportType === 'script' || category === 'script') return 'script';
    return 'generic';
  }

  static extractStructuredEvidence(task) {
    let report = safeJsonParse(task.completion_report, null);
    if (!report && (task.task_category === 'inspection' || `${task.title || ''} ${task.description || ''}`.includes('巡检'))) {
      report = CompletionReportBuilder.build(task, task.agent_id);
      if (report) {
        CompletionReportBuilder.storeReport(task.id, task.agent_id, report);
      }
    }
    if (!report) {
      return { report: null, evidence: null };
    }

    const validationEvidence = safeJsonParse(report.validationEvidence, report.validationEvidence || {});
    const criteriaMet = Array.isArray(validationEvidence?.criteriaMet) ? validationEvidence.criteriaMet : [];
    const artifacts = Array.isArray(validationEvidence?.artifacts) ? validationEvidence.artifacts : [];
    const evidenceLines = Array.isArray(validationEvidence?.evidenceLines) ? validationEvidence.evidenceLines : [];
    const summary = String(report.userSummary || report.summary || '').trim();
    const sectionCount = Array.isArray(report.sections) ? report.sections.length : 0;

    return {
      report,
      evidence: {
        summary,
        criteriaMet,
        artifacts,
        evidenceLines,
        sectionCount,
        labels: Array.isArray(report.sections) ? report.sections.map(section => section.label) : []
      }
    };
  }

  static validate(task) {
    const dataTaskResult = DataTaskValidationService.validate(task);
    if (dataTaskResult.applied) {
      return dataTaskResult;
    }

    const { report, evidence } = this.extractStructuredEvidence(task);
    if (!report || !evidence) {
      return { applied: false, reason: 'missing_completion_report' };
    }

    if (!evidence.summary && evidence.sectionCount === 0) {
      return { applied: false, reason: 'missing_structured_evidence' };
    }

    const policy = this.inferPolicy(task, report);
    switch (policy) {
      case 'inspection':
        return this._validateInspection(task, report, evidence);
      case 'backup':
        return this._validateBackup(task, report, evidence);
      case 'code_change':
        return this._validateCodeChange(task, report, evidence);
      case 'script':
        return this._validateScript(task, report, evidence);
      default:
        return this._validateGeneric(task, report, evidence);
    }
  }

  static _pass(policy, reason, score, evidenceSummary, feedback) {
    return {
      applied: true,
      pass: true,
      score,
      reason,
      feedback: feedback || reason,
      validator: `policy:${policy}`,
      evidence_summary: evidenceSummary
    };
  }

  static _fail(policy, reason, score, evidenceSummary, feedback) {
    return {
      applied: true,
      pass: false,
      score,
      reason,
      feedback: feedback || reason,
      validator: `policy:${policy}`,
      evidence_summary: evidenceSummary
    };
  }

  static _validateInspection(task, report, evidence) {
    const coverage = collectSectionItems(report, ['数据覆盖']);
    const conclusions = collectSectionItems(report, ['巡检结论', '巡检结果', '健康度']);
    const overall = String(report.overall || '').toLowerCase();
    const evidenceSummary = [
      evidence.summary,
      coverage[0],
      conclusions[0]
    ].filter(Boolean);

    if (overall === 'error' || overall === 'critical') {
      return this._fail('inspection', '巡检结果存在 error/critical，不能通过自动验收', 35, evidenceSummary, '巡检报告显示异常，需人工复核后再放行。');
    }

    if (evidenceSummary.length >= 2) {
      const score = overall === 'warning' ? 78 : 88;
      const reason = overall === 'warning'
        ? '巡检报告结构完整，存在 warning 但未达到阻断级别'
        : '巡检报告结构完整，包含覆盖结论与摘要';
      return this._pass('inspection', reason, score, evidenceSummary);
    }

    return { applied: false, reason: 'inspection_evidence_insufficient' };
  }

  static _validateScript(task, report, evidence) {
    const artifactItems = collectSectionItems(report, ['产出位置', '产出物', '数据文件位置', '数据存储', '时间覆盖', '执行结果']);
    const criteriaEvidence = evidence.criteriaMet;
    const evidenceSummary = [
      evidence.summary,
      artifactItems[0],
      criteriaEvidence[0]
    ].filter(Boolean);

    if (hasCriticalFailureText(evidence.summary) || artifactItems.some(item => hasCriticalFailureText(item))) {
      return this._fail('script', '执行报告包含明显失败/异常字样，不能通过自动验收', 40, evidenceSummary, '请补齐实际产出证据后重新提交验收。');
    }

    if (artifactItems.length > 0 && (criteriaEvidence.length > 0 || evidence.artifacts.length > 0 || evidence.evidenceLines.length > 0)) {
      return this._pass('script', '脚本类任务已提交结构化产出和验收证据', 86, evidenceSummary);
    }

    return { applied: false, reason: 'script_evidence_insufficient' };
  }

  static _validateBackup(task, report, evidence) {
    const backupItems = collectSectionItems(report, ['备份位置', '备份大小', '产出物']);
    const evidenceSummary = [
      evidence.summary,
      backupItems[0],
      evidence.artifacts[0]
    ].filter(Boolean);

    if (backupItems.length >= 1 && (evidence.artifacts.length > 0 || evidence.evidenceLines.length > 0)) {
      return this._pass('backup', '备份任务已提交备份位置和产出证据', 88, evidenceSummary);
    }

    return { applied: false, reason: 'backup_evidence_insufficient' };
  }

  static _validateCodeChange(task, report, evidence) {
    const changedFiles = collectSectionItems(report, ['修改的文件', '代码位置', '变更摘要']);
    const evidenceSummary = [
      evidence.summary,
      changedFiles[0],
      evidence.criteriaMet[0]
    ].filter(Boolean);

    if (changedFiles.length > 0 && evidence.sectionCount > 0) {
      return this._pass('code_change', '代码变更任务已提交结构化变更清单', 82, evidenceSummary);
    }

    return { applied: false, reason: 'code_change_evidence_insufficient' };
  }

  static _validateGeneric(task, report, evidence) {
    const evidenceSummary = [
      evidence.summary,
      evidence.criteriaMet[0],
      evidence.artifacts[0],
      evidence.evidenceLines[0]
    ].filter(Boolean);

    if (evidenceSummary.length >= 3 && !hasCriticalFailureText(evidence.summary)) {
      return this._pass('generic', '任务已提交较完整的结构化完成证据', 78, evidenceSummary);
    }

    return { applied: false, reason: 'generic_evidence_insufficient' };
  }
}

module.exports = ValidationPolicyService;
