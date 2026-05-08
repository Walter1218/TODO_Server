const { execFileSync } = require('child_process');
const DataTaskSpecService = require('./DataTaskSpecService');

function stringifyRow(row) {
  if (!row || typeof row !== 'object') return '';
  return Object.entries(row).map(([key, value]) => `${key}=${value}`).join(', ');
}

function normalizeLagDays(value) {
  const days = Number(value ?? 1);
  return Number.isFinite(days) && days >= 0 ? Math.floor(days) : 1;
}

class DataTaskValidationService {
  static validate(task) {
    const spec = DataTaskSpecService.getEffectiveTaskSpec(task);
    if (!spec || spec.kind !== 'data_task') {
      return { applied: false, reason: 'missing_data_task_spec' };
    }
    if (!Array.isArray(spec.checks) || spec.checks.length === 0 || !spec.path || !spec.engine) {
      return { applied: false, reason: 'invalid_data_task_spec' };
    }

    const payload = {
      engine: spec.engine,
      path: spec.path,
      checks: this._adaptChecksForEngine(spec.checks, spec.engine)
    };

    try {
      const output = execFileSync('python3', ['-c', this._pythonScript()], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024
      });
      const parsed = JSON.parse(output || '{}');
      const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
      if (checks.length === 0) {
        return { applied: false, reason: 'data_task_validation_empty' };
      }

      const failed = checks.filter(check => !check.passed);
      const evidenceSummary = checks.slice(0, 4).map(check => {
        const row = Array.isArray(check.rows) && check.rows.length > 0 ? stringifyRow(check.rows[0]) : '';
        return `${check.label}:${check.passed ? 'pass' : 'fail'}${row ? ` (${row})` : ''}${check.error ? ` error=${check.error}` : ''}`;
      });

      const deferResult = this._buildDeferredResult(task, spec, failed, evidenceSummary);
      if (deferResult) {
        return deferResult;
      }

      if (failed.length === 0) {
        return {
          applied: true,
          pass: true,
          score: 92,
          reason: '数据任务目标库校验全部通过',
          feedback: '目标库、目标表和验收 SQL 已全部通过。',
          validator: 'policy:data_task',
          evidence_summary: evidenceSummary
        };
      }

      return {
        applied: true,
        pass: false,
        score: 38,
        reason: `数据任务库校验失败: ${failed.map(item => item.label).join(', ')}`,
        feedback: '目标库结果未达标，请先修复数据落库再重新提交验收。',
        validator: 'policy:data_task',
        evidence_summary: evidenceSummary
      };
    } catch (error) {
      return {
        applied: true,
        pass: false,
        score: 20,
        reason: `数据任务库校验执行失败: ${error.message}`,
        feedback: '数据任务库校验器执行失败，请检查 Python/DuckDB/SQLite 环境。',
        validator: 'policy:data_task',
        evidence_summary: []
      };
    }
  }

  static _adaptChecksForEngine(checks, engine) {
    return (Array.isArray(checks) ? checks : []).map((check) => ({
      ...check,
      sql: this._adaptSql(check?.sql || '', engine)
    }));
  }

  static _adaptSql(sql, engine) {
    let adapted = String(sql || '');
    if (!adapted) return adapted;

    if (engine === 'sqlite') {
      adapted = adapted.replace(
        /strftime\(CURRENT_DATE\s*-\s*INTERVAL\s+(\d+)\s+DAY,\s*'(%Y%m%d)'\)/gi,
        (_, days, format) => `strftime('${format}', 'now', '-${days} day')`
      );
      adapted = adapted.replace(
        /strftime\(CURRENT_DATE\s*-\s*INTERVAL\s+(\d+)\s+DAY,\s*'(%Y-%m-%d)'\)/gi,
        (_, days, format) => `strftime('${format}', 'now', '-${days} day')`
      );
    } else if (engine === 'duckdb') {
      adapted = adapted.replace(
        /strftime\('(%Y%m%d|%Y-%m-%d)'\s*,\s*'now'\s*,\s*'-(\d+)\s+day'\)/gi,
        (_, format, days) => `strftime(CURRENT_DATE - INTERVAL ${days} DAY, '${format}')`
      );
    }

    return adapted;
  }

  static _buildDeferredResult(task, spec, failedChecks, evidenceSummary) {
    if (!failedChecks.length) return null;
    const validation = spec?.validation || {};
    const sourceProbes = Array.isArray(validation?.sourceProbes) && validation.sourceProbes.length > 0
      ? validation.sourceProbes
      : (validation?.sourceProbe ? [validation.sourceProbe] : []);

    for (const sourceProbe of sourceProbes) {
      if (!sourceProbe || sourceProbe.allowDeferred === false) continue;

      const applicableLabels = new Set(sourceProbe.appliesToLabels || []);
      if (applicableLabels.size > 0 && failedChecks.some(check => !applicableLabels.has(check.label))) {
        continue;
      }

      const sourceResult = this._probeSourceAvailability(sourceProbe);
      if (!sourceResult || sourceResult.error || sourceResult.rows !== 0) {
        continue;
      }

      return {
        applied: true,
        pass: false,
        deferred: true,
        score: 65,
        reason: `数据源 ${sourceProbe.api} 在目标日期无新增数据，已延期下次调度再验收`,
        feedback: '源头当日返回 0 行，任务不记为失败，等待下次调度或下一交易日再自动校验。',
        validator: 'policy:data_task',
        evidence_summary: [
          ...evidenceSummary,
          `source_probe:${sourceProbe.api}=0`
        ].slice(0, 5),
        deferred_until: this._nextRetryAt(),
        source_probe: sourceResult
      };
    }
    return null;
  }

  static _nextRetryAt() {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }

  static _probeSourceAvailability(sourceProbe) {
    const payload = {
      ...sourceProbe,
      lagDays: normalizeLagDays(sourceProbe?.lagDays)
    };
    try {
      const output = execFileSync('python3', ['-c', this._pythonSourceProbeScript()], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1024 * 1024
      });
      const parsed = JSON.parse(output || '{}');
      return {
        rows: Number(parsed.rows || 0),
        trade_date: parsed.trade_date || null,
        api: parsed.api || payload.api,
        error: parsed.error || null
      };
    } catch (error) {
      return {
        rows: null,
        trade_date: null,
        api: payload.api,
        error: error.message
      };
    }
  }

  static _pythonScript() {
    return `
import json, os, sys, sqlite3
payload = json.loads(sys.stdin.read() or '{}')
engine = payload.get('engine')
db_path = payload.get('path')
checks = payload.get('checks') or []
result = {'checks': []}
if not os.path.exists(db_path):
    print(json.dumps({'checks':[{'label':'db_exists','passed':False,'error':f'database not found: {db_path}'}]}, ensure_ascii=False))
    raise SystemExit(0)
if engine == 'sqlite':
    conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
else:
    import duckdb
    conn = duckdb.connect(db_path, read_only=True)
for check in checks:
    label = check.get('label') or 'unnamed_check'
    sql = check.get('sql') or ''
    item = {'label': label}
    try:
        cur = conn.execute(sql)
        columns = [d[0] for d in (cur.description or [])]
        rows = cur.fetchall()
        normalized_rows = []
        for row in rows[:3]:
            normalized_rows.append({columns[idx] if idx < len(columns) else str(idx): (None if value is None else str(value)) for idx, value in enumerate(row)})
        item['rows'] = normalized_rows
        if normalized_rows and 'passed' in normalized_rows[0]:
            value = normalized_rows[0]['passed']
            item['passed'] = str(value).lower() in ('1', 'true', 't')
        elif rows and len(rows[0]) > 0:
            item['passed'] = bool(rows[0][0])
        else:
            item['passed'] = False
    except Exception as exc:
        item['passed'] = False
        item['error'] = str(exc)
    result['checks'].append(item)
print(json.dumps(result, ensure_ascii=False))
`;
  }

  static _pythonSourceProbeScript() {
    return `
import json, os, re, sys
from datetime import datetime, timedelta
payload = json.loads(sys.stdin.read() or '{}')
token_path = payload.get('tokenSourcePath')
token = os.environ.get('TUSHARE_API_TOKEN') or os.environ.get('TUSHARE_TOKEN')
if not token and token_path and os.path.exists(token_path):
    text = open(token_path, 'r', encoding='utf-8').read()
    match = re.search(r'TUSHARE_API_TOKEN=\\"([^\\"]+)\\"', text)
    if match:
        token = match.group(1)
if not token:
    print(json.dumps({'rows': None, 'error': 'missing_tushare_token', 'api': payload.get('api')}, ensure_ascii=False))
    raise SystemExit(0)
import tushare as ts
ts.set_token(token)
pro = ts.pro_api()
lag_value = payload.get('lagDays')
lag = int(lag_value) if lag_value is not None else 1
trade_date = (datetime.utcnow() - timedelta(days=lag)).strftime('%Y%m%d')
api = payload.get('api')
query_mode = payload.get('queryMode') or 'trade_date'
method = getattr(pro, api, None)
if method is None:
    print(json.dumps({'rows': None, 'error': f'unknown_api:{api}', 'api': api, 'trade_date': trade_date}, ensure_ascii=False))
    raise SystemExit(0)
if query_mode == 'range':
    df = method(start_date=trade_date, end_date=trade_date)
else:
    df = method(trade_date=trade_date)
rows = 0 if df is None else len(df)
print(json.dumps({'rows': rows, 'trade_date': trade_date, 'api': api}, ensure_ascii=False))
`;
  }
}

module.exports = DataTaskValidationService;
