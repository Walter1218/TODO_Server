const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');

const TUSHARE_DATA_DIR = process.env.TUSHARE_DATA_DIR || '/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/';
const BACKUP_DIR = process.env.BACKUP_DIR || '/Users/onetwo/a_share_warehouse/backups';
const INSPECTION_REPORT_DIR = process.env.TUSHARE_REPORT_DIR || '/Users/onetwo/.openclaw/workspace/tushare_warehouse/reports';

class CompletionReportBuilder {
  static build(task, agentId) {
    const category = task.task_category || 'general';
    switch (category) {
      case 'inspection':
        return this._buildInspectionReport(task, agentId);
      case 'script':
        return this._buildScriptReport(task, agentId);
      case 'code_change':
        return this._buildCodeChangeReport(task, agentId);
      default:
        return this._buildGenericReport(task, agentId);
    }
  }

  static _buildInspectionReport(task, agentId) {
    const desc = task.description || '';
    const title = task.title || '';
    const report = { type: 'inspection', sections: [] };
    const inspectionReport = this._loadInspectionJson(task);

    if (inspectionReport) {
      const summary = inspectionReport.summary || {};
      const total = Number(summary.total || 0);
      const ok = Number(summary.ok || 0);
      const warning = Number(summary.warning || 0);
      const error = Number(summary.error || 0);
      const staticCount = Number(summary.static || 0);
      report.overall = error > 0 ? 'error' : warning > 0 ? 'warning' : 'ok';
      report.sections.push({
        label: '巡检结论',
        items: [
          error > 0
            ? `巡检发现 ${error} 项 error，需人工介入`
            : warning > 0
              ? `巡检完成，${warning} 项 warning，当前未达到阻断级别`
              : '巡检完成，全部动态检查项正常'
        ]
      });
      report.sections.push({
        label: '数据覆盖',
        items: [
          `共检查 ${total} 项：ok ${ok} 项，warning ${warning} 项，error ${error} 项，static ${staticCount} 项`
        ]
      });
      report.sections.push({
        label: '健康度',
        items: [
          `ok: ${ok}`,
          `warning: ${warning}`,
          `error: ${error}`,
          `static: ${staticCount}`
        ]
      });

      const warningItems = Array.isArray(inspectionReport.results)
        ? inspectionReport.results
          .filter(item => item.status === 'warning')
          .map(item => `${item.label}: latest=${item.max_date || item.max_ann_date || 'n/a'}, days_old=${item.days_old ?? 'n/a'}, null_rate=${item.null_rate ?? 'n/a'}`)
        : [];
      if (warningItems.length > 0) {
        report.sections.push({
          label: '告警详情',
          items: warningItems
        });
      }

      report.validationEvidence = {
        criteriaMet: [
          error === 0 ? '巡检报告 error 数量为 0' : `巡检报告存在 ${error} 项 error`,
          `巡检报告已生成: ${this._resolveInspectionReportPath(task) || 'unknown'}`
        ],
        artifacts: [this._resolveInspectionReportPath(task)].filter(Boolean),
        evidenceLines: warningItems
      };
      report.summary = this._generateInspectionSummary(report);
      return report;
    }

    const duckdbInfo = this._scanDuckdbFiles();
    if (duckdbInfo.exists) {
      report.sections.push({
        label: '数据仓库状态',
        items: [
          `数据库数量: ${duckdbInfo.totalDbs} 个`,
          `总大小: ${duckdbInfo.totalSizeMB} MB`,
          `最新修改: ${duckdbInfo.latestModified || '未知'}`,
        ]
      });
    }

    const summaryMatch = desc.match(/整体状态[：:]\s*(.+)/);
    if (summaryMatch) {
      report.sections.push({ label: '巡检结论', items: [summaryMatch[1].trim().substring(0, 200)] });
    }

    const overallMatch = desc.match(/overall[:\s]*(healthy|warning|error|ok|critical)/i);
    if (overallMatch) {
      report.overall = overallMatch[1].toLowerCase();
    }

    const tableMatch = desc.match(/(\d+)\/(\d+)\s*表/);
    if (tableMatch) {
      report.sections.push({
        label: '数据覆盖',
        items: [`${tableMatch[1]}/${tableMatch[2]} 表正常`]
      });
    }

    const warningMatch = desc.match(/warning[:\s]*(\d+)/i);
    const errorMatch = desc.match(/error[:\s]*(\d+)/i);
    if (warningMatch || errorMatch) {
      report.sections.push({
        label: '健康度',
        items: [
          warningMatch ? `警告: ${warningMatch[1]} 项` : '',
          errorMatch ? `错误: ${errorMatch[1]} 项` : '',
        ].filter(Boolean)
      });
    }

    if (report.sections.length === 0) {
      report.sections.push({
        label: '巡检结果',
        items: [desc.substring(0, 300) || '巡检已完成，未提取到结构化信息']
      });
    }

    report.summary = this._generateInspectionSummary(report);
    return report;
  }

  static _resolveInspectionReportPath(task) {
    const dateCandidates = [];
    const createdAt = task?.created_at ? String(task.created_at).slice(0, 10) : '';
    if (createdAt) dateCandidates.push(createdAt);
    dateCandidates.push(new Date().toISOString().slice(0, 10));

    for (const day of dateCandidates) {
      const fullPath = path.join(INSPECTION_REPORT_DIR, `daily_inspection_${day}.json`);
      if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
  }

  static _loadInspectionJson(task) {
    try {
      const reportPath = this._resolveInspectionReportPath(task);
      if (!reportPath) return null;
      return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  static _buildScriptReport(task, agentId) {
    const desc = task.description || '';
    const title = task.title || '';
    const combined = title + ' ' + desc;
    const report = { type: 'script', sections: [] };

    if (combined.includes('backup') || combined.includes('备份')) {
      const backupInfo = this._scanBackups();
      if (backupInfo.exists) {
        report.sections.push({
          label: '备份位置',
          items: [`路径: ${BACKUP_DIR}`, `文件数: ${backupInfo.count}`, `最新: ${backupInfo.latest || '未知'}`]
        });
        if (backupInfo.sizeMB) {
          report.sections.push({ label: '备份大小', items: [`${backupInfo.sizeMB} MB`] });
        }
      }
    }

    if (combined.includes('duckdb') || combined.includes('sync') || combined.includes('同步')) {
      const dbInfo = this._scanDuckdbFiles();
      if (dbInfo.exists) {
        report.sections.push({
          label: '数据文件位置',
          items: [`路径: ${TUSHARE_DATA_DIR}`, `数据库: ${dbInfo.totalDbs} 个`, `总大小: ${dbInfo.totalSizeMB} MB`]
        });
      }

      const timeRange = this._extractTimeRange(combined, desc);
      if (timeRange) {
        report.sections.push({ label: '时间覆盖', items: [timeRange] });
      }
    }

    if (combined.includes('daily_quote') || combined.includes('日线') || combined.includes('A股')) {
      const dbInfo = this._scanDuckdbFiles();
      if (dbInfo.exists) {
        const largest = dbInfo.largestFile;
        report.sections.push({
          label: '数据存储',
          items: [
            `路径: ${TUSHARE_DATA_DIR}`,
            largest ? `最大文件: ${largest.name} (${largest.sizeMB} MB)` : '',
            `共 ${dbInfo.totalDbs} 个数据库文件`,
          ].filter(Boolean)
        });
      }
    }

    const completionMatch = desc.match(/完成度[：:]\s*(\d+%?)/i);
    if (completionMatch) {
      report.sections.push({ label: '完成度', items: [completionMatch[1]] });
    }

    const missingMatch = desc.match(/缺失[：:]\s*(.+)/i);
    if (missingMatch) {
      report.sections.push({ label: '数据缺失', items: [missingMatch[1].substring(0, 200)] });
    }

    if (report.sections.length === 0) {
      report.sections.push({
        label: '执行结果',
        items: [desc.substring(0, 300) || '脚本执行完成，未提取到结构化信息']
      });
    }

    report.summary = this._generateScriptSummary(report);
    return report;
  }

  static _buildCodeChangeReport(task, agentId) {
    const desc = task.description || '';
    const title = task.title || '';
    const report = { type: 'code_change', sections: [] };

    const projectRoot = path.resolve(__dirname, '../..');
    const recentFiles = this._findRecentlyModifiedFiles(projectRoot, 30 * 60 * 1000);
    if (recentFiles.length > 0) {
      report.sections.push({
        label: '修改的文件',
        items: recentFiles.slice(0, 10).map(f => f.replace(projectRoot + '/', ''))
      });
    }

    const codeMatch = desc.match(/(?:代码|文件|模块)[：:]\s*(.+)/i);
    if (codeMatch) {
      report.sections.push({ label: '代码位置', items: [codeMatch[1]] });
    }

    if (report.sections.length === 0) {
      report.sections.push({
        label: '变更摘要',
        items: [desc.substring(0, 300) || '代码变更已完成']
      });
    }

    report.summary = this._generateCodeChangeSummary(report);
    return report;
  }

  static _buildGenericReport(task, agentId) {
    const desc = task.description || '';
    const report = { type: 'generic', sections: [] };

    if (desc) {
      const lines = desc.split('\n').filter(l => l.trim()).slice(0, 10);
      report.sections.push({ label: '任务信息', items: lines.map(l => l.substring(0, 200)) });
    }

    report.summary = desc ? desc.substring(0, 200) : '任务已完成';
    return report;
  }

  static _scanDuckdbFiles() {
    try {
      if (!fs.existsSync(TUSHARE_DATA_DIR)) return { exists: false };
      const files = fs.readdirSync(TUSHARE_DATA_DIR).filter(f => f.endsWith('.duckdb'));
      let totalSize = 0;
      let latestTime = 0;
      let largestFile = null;
      for (const f of files) {
        const stat = fs.statSync(path.join(TUSHARE_DATA_DIR, f));
        totalSize += stat.size;
        if (stat.mtimeMs > latestTime) latestTime = stat.mtimeMs;
        if (!largestFile || stat.size > largestFile.size) {
          largestFile = { name: f, size: stat.size, sizeMB: (stat.size / 1048576).toFixed(1) };
        }
      }
      return {
        exists: true,
        totalDbs: files.length,
        totalSizeMB: (totalSize / 1048576).toFixed(1),
        latestModified: latestTime ? new Date(latestTime).toISOString().replace('T', ' ').substring(0, 19) : null,
        largestFile
      };
    } catch (e) {
      return { exists: false };
    }
  }

  static _scanBackups() {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return { exists: false };
      const files = fs.readdirSync(BACKUP_DIR);
      let totalSize = 0;
      let latestTime = 0;
      let latestName = null;
      for (const f of files) {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        totalSize += stat.size;
        if (stat.mtimeMs > latestTime) {
          latestTime = stat.mtimeMs;
          latestName = f;
        }
      }
      return {
        exists: files.length > 0,
        count: files.length,
        sizeMB: (totalSize / 1048576).toFixed(1),
        latest: latestName
      };
    } catch (e) {
      return { exists: false };
    }
  }

  static _extractTimeRange(combined, desc) {
    const yearMatch = desc.match(/(\d{4})[-/](\d{2})[-/](\d{2})/g);
    if (yearMatch && yearMatch.length >= 2) {
      const sorted = yearMatch.sort();
      return `时间范围: ${sorted[0]} 至 ${sorted[sorted.length - 1]}`;
    }
    const yearOnly = desc.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (yearOnly) {
      return `时间范围: ${yearOnly[0]}`;
    }
    return null;
  }

  static _findRecentlyModifiedFiles(dir, withinMs, maxDepth = 3) {
    const results = [];
    const now = Date.now();
    const ignore = ['node_modules', '.git', 'dist', 'build', 'data'];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignore.includes(entry.name)) continue;
        if (results.length >= 10) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs < withinMs) {
            results.push(fullPath);
          }
        } else if (entry.isDirectory() && maxDepth > 0) {
          results.push(...this._findRecentlyModifiedFiles(fullPath, withinMs, maxDepth - 1));
        }
      }
    } catch (e) {}
    return results;
  }

  static _generateInspectionSummary(report) {
    const overall = report.overall || 'unknown';
    const statusEmoji = overall === 'healthy' ? '✅' : overall === 'warning' ? '⚠️' : overall === 'error' ? '❌' : '📋';
    const coverage = report.sections.find(s => s.label === '数据覆盖');
    const conclusion = report.sections.find(s => s.label === '巡检结论');
    const parts = [`${statusEmoji} 巡检完成 (${overall})`];
    if (coverage) parts.push(coverage.items[0]);
    if (conclusion) parts.push(conclusion.items[0].substring(0, 100));
    return parts.join(' | ');
  }

  static _generateScriptSummary(report) {
    const parts = ['📋 脚本执行完成'];
    for (const s of report.sections) {
      if (s.items.length > 0) parts.push(`${s.label}: ${s.items[0]}`);
    }
    return parts.join(' | ');
  }

  static _generateCodeChangeSummary(report) {
    const files = report.sections.find(s => s.label === '修改的文件');
    if (files) {
      return `💻 代码变更: 修改了 ${files.items.length} 个文件 (${files.items.slice(0, 3).join(', ')})`;
    }
    return '💻 代码变更已完成';
  }

  static storeReport(taskId, agentId, report) {
    const db = getDb();
    db.prepare(`UPDATE todos SET completion_report = ? WHERE id = ?`).run(JSON.stringify(report), taskId);
  }
}

module.exports = CompletionReportBuilder;
