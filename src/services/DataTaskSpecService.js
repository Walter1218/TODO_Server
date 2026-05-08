const path = require('path');

const HOME_DIR = process.env.HOME || '/Users/onetwo';
const WORKSPACE_ROOT = path.join(HOME_DIR, '.openclaw', 'workspace');
const TUSHARE_ROOT = path.join(WORKSPACE_ROOT, 'tushare_warehouse');
const SCRIPTS_ROOT = path.join(TUSHARE_ROOT, 'scripts');
const STOCK_BACKFILL_ROOT = path.join(WORKSPACE_ROOT, 'stock_backfill');
const DATA_ROOT = process.env.DATA_TASK_DB_ROOT || path.join(TUSHARE_ROOT, 'data');
const RUN_INDEX_PATH = path.join(TUSHARE_ROOT, 'run_index.sh');
const TUSHARE_TOKEN_PATH = path.join(STOCK_BACKFILL_ROOT, '.token');
const DATA_TASK_PYTHON = process.env.DATA_TASK_PYTHON || process.env.CONDA_PYTHON_EXE || '/opt/homebrew/bin/python3';

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function withShellEnv(command, env = {}) {
  const entries = Object.entries(env).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return command;

  const exports = entries.map(([key, value]) => `export ${key}=${shellQuote(value)};`).join(' ');
  if (!command.startsWith('bash -lc ')) {
    return `${exports} ${command}`.trim();
  }

  const rawShell = command.slice('bash -lc '.length);
  let shellBody = rawShell;
  if (rawShell.startsWith("'") && rawShell.endsWith("'")) {
    shellBody = rawShell.slice(1, -1).replace(/'\\''/g, "'");
  }
  return `bash -lc ${shellQuote(`${exports} ${shellBody}`.trim())}`;
}

function buildOfficialScript(scriptName, options = {}) {
  const cwd = options.cwd || SCRIPTS_ROOT;
  const scriptPath = path.isAbsolute(scriptName) ? scriptName : path.join(cwd, scriptName);
  const args = Array.isArray(options.args) ? options.args.filter(Boolean) : [];
  const bootstrap = options.sourceRunIndex === false
    ? ''
    : `TOKEN_FILE=${shellQuote(TUSHARE_TOKEN_PATH)}; if [ -f "$TOKEN_FILE" ]; then export TUSHARE_API_TOKEN="$(tr -d '\\r\\n' < "$TOKEN_FILE")"; export TUSHARE_TOKEN="$TUSHARE_API_TOKEN"; fi; `;
  const argScript = args.map(shellQuote).join(' ');
  const shellScript = `${bootstrap}cd ${shellQuote(cwd)} && ${shellQuote(DATA_TASK_PYTHON)} ${shellQuote(scriptPath)}${argScript ? ` ${argScript}` : ''}`;
  return {
    mode: 'official_script',
    cwd,
    scriptPath,
    timeoutMs: options.timeoutMs || 300000,
    command: `bash -lc ${shellQuote(shellScript)}`,
    requirements: {
      runIndexPath: options.sourceRunIndex === false ? null : RUN_INDEX_PATH,
      tokenPath: options.sourceRunIndex === false ? null : TUSHARE_TOKEN_PATH,
      cwd,
      scriptPath
    }
  };
}

function buildSourceProbe(api, options = {}) {
  return {
    provider: 'tushare',
    api,
    tokenSourcePath: RUN_INDEX_PATH,
    lagDays: options.lagDays ?? 1,
    queryMode: options.queryMode || 'trade_date',
    appliesToLabels: options.appliesToLabels || [],
    allowDeferred: options.allowDeferred !== false
  };
}

function normalizeSourceProbes(validation) {
  if (!validation || typeof validation !== 'object') return null;
  const probes = Array.isArray(validation.sourceProbes)
    ? validation.sourceProbes.filter(Boolean)
    : (validation.sourceProbe ? [validation.sourceProbe] : []);
  if (probes.length === 0) return validation;
  return {
    ...validation,
    sourceProbe: probes[0],
    sourceProbes: probes
  };
}

function buildDuckDbSpec(title, fileName, checks, options = {}) {
  return {
    kind: 'data_task',
    engine: 'duckdb',
    path: path.join(DATA_ROOT, fileName),
    owner: options.owner || 'hermes-default',
    target: options.target || null,
    checks,
    execution: options.execution || null,
    validation: options.validation || null
  };
}

function buildTradeDateChecks(table, lagDays = 1, dateFormat = '%Y%m%d', latestRowsMin = 1) {
  return [
    {
      label: `${table}_latest_date`,
      sql: `SELECT REPLACE(CAST(MAX(trade_date) AS VARCHAR), '-', '') >= strftime(CURRENT_DATE - INTERVAL ${lagDays} DAY, '${dateFormat}') AS passed, CAST(MAX(trade_date) AS VARCHAR) AS latest_value FROM ${table}`
    },
    {
      label: `${table}_latest_rows`,
      sql: `SELECT COUNT(*) >= ${latestRowsMin} AS passed, COUNT(*) AS latest_rows FROM ${table} WHERE REPLACE(CAST(trade_date AS VARCHAR), '-', '') = (SELECT REPLACE(CAST(MAX(trade_date) AS VARCHAR), '-', '') FROM ${table})`
    }
  ];
}

const PRESETS = [
  {
    match: /每日 A股日线数据全量采集/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_daily.duckdb', [
      ...buildTradeDateChecks('daily_quote'),
      ...buildTradeDateChecks('daily_basic')
    ], {
      target: { tables: ['daily_quote', 'daily_basic'], dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_daily_tushare.py', {
        args: ['--days', '1']
      })
    })
  },
  {
    match: /每日 A股日线数据增量同步|daily_quote/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_daily.duckdb', buildTradeDateChecks('daily_quote'), {
      target: { table: 'daily_quote', dateColumn: 'trade_date' }
    })
  },
  {
    match: /SQLite stock\.db/i,
    build: (title) => ({
      kind: 'data_task',
      engine: 'sqlite',
      path: path.join(STOCK_BACKFILL_ROOT, 'data', 'stock.db'),
      owner: 'hermes-default',
      target: { table: 'fact_daily', dateColumn: 'date' },
      checks: [
        {
          label: 'fact_daily_latest_date',
          sql: "SELECT REPLACE(CAST(MAX(date) AS VARCHAR), '-', '') >= strftime(CURRENT_DATE - INTERVAL 1 DAY, '%Y%m%d') AS passed, CAST(MAX(date) AS VARCHAR) AS latest_value FROM fact_daily"
        },
        {
          label: 'fact_daily_latest_rows',
          sql: 'SELECT COUNT(*) >= 1 AS passed, COUNT(*) AS latest_rows FROM fact_daily WHERE date = (SELECT MAX(date) FROM fact_daily)'
        }
      ],
      execution: buildOfficialScript('daily_update_wrapper.py'),
      validation: null
    })
  },
  {
    match: /adj_factor/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_adj_factor.duckdb', buildTradeDateChecks('fact_adj_factor'), {
      target: { table: 'fact_adj_factor', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_adj_factor_v2.py')
    })
  },
  {
    match: /dividend/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_dividend.duckdb', [
      {
        label: 'fact_dividend_latest_record_date',
        sql: "SELECT CAST(MAX(record_date) AS VARCHAR) >= strftime(CURRENT_DATE - INTERVAL 1 DAY, '%Y%m%d') AS passed, CAST(MAX(record_date) AS VARCHAR) AS latest_value FROM fact_dividend"
      }
    ], {
      target: { table: 'fact_dividend', dateColumn: 'record_date' },
      execution: buildOfficialScript('fetch_dividend_v2.py')
    })
  },
  {
    match: /block_trade/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_block_trade_v2.duckdb', buildTradeDateChecks('block_trade', 0), {
      target: { table: 'block_trade', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_block_trade_v2.py'),
      validation: {
        sourceProbe: buildSourceProbe('block_trade', {
          lagDays: 0,
          appliesToLabels: ['block_trade_latest_date', 'block_trade_latest_rows']
        })
      }
    })
  },
  {
    match: /index_daily/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_index_daily.duckdb', buildTradeDateChecks('index_daily'), {
      target: { table: 'index_daily', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_index_daily_v2.py')
    })
  },
  {
    match: /hsgt/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_hsgt.duckdb', [
      ...buildTradeDateChecks('fact_hk_hold', 0),
      ...buildTradeDateChecks('fact_hsgt_top10', 0)
    ], {
      target: { tables: ['fact_hk_hold', 'fact_hsgt_top10'], dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_hsgt_hk_hold.py'),
      validation: normalizeSourceProbes({
        sourceProbes: [
          buildSourceProbe('hk_hold', {
            lagDays: 0,
            appliesToLabels: ['fact_hk_hold_latest_date', 'fact_hk_hold_latest_rows']
          })
        ]
      })
    })
  },
  {
    match: /stk_limit/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_stklimit.duckdb', buildTradeDateChecks('fact_stk_limit', 0), {
      target: { table: 'fact_stk_limit', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_stk_limit.py'),
      validation: {
        sourceProbe: buildSourceProbe('stk_limit', {
          lagDays: 0,
          appliesToLabels: ['fact_stk_limit_latest_date', 'fact_stk_limit_latest_rows']
        })
      }
    })
  },
  {
    match: /margin_detail/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_margin_detail.duckdb', buildTradeDateChecks('fact_margin_detail'), {
      target: { table: 'fact_margin_detail', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_margin_detail.py'),
      validation: {
        sourceProbe: buildSourceProbe('margin_detail', {
          appliesToLabels: ['fact_margin_detail_latest_date', 'fact_margin_detail_latest_rows']
        })
      }
    })
  },
  {
    match: /融资融券数据增量同步|margin/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_margin.duckdb', buildTradeDateChecks('fact_margin'), {
      target: { table: 'fact_margin', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_margin.py'),
      validation: {
        sourceProbe: buildSourceProbe('margin', {
          queryMode: 'range',
          appliesToLabels: ['fact_margin_latest_date', 'fact_margin_latest_rows']
        })
      }
    })
  },
  {
    match: /moneyflow/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_moneyflow.duckdb', buildTradeDateChecks('fact_moneyflow'), {
      target: { table: 'fact_moneyflow', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_moneyflow_v2.py')
    })
  },
  {
    match: /top_list/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_toplist.duckdb', buildTradeDateChecks('fact_top_list', 0), {
      target: { table: 'fact_top_list', dateColumn: 'trade_date' },
      execution: buildOfficialScript('fetch_top_list.py'),
      validation: {
        sourceProbe: buildSourceProbe('top_list', {
          lagDays: 0,
          appliesToLabels: ['fact_top_list_latest_date', 'fact_top_list_latest_rows']
        })
      }
    })
  },
  {
    match: /concept/i,
    build: (title) => buildDuckDbSpec(title, 'tushare_concept.duckdb', [
      { label: 'dim_concept_non_empty', sql: 'SELECT COUNT(*) > 0 AS passed, COUNT(*) AS row_count FROM dim_concept' },
      { label: 'dim_concept_detail_non_empty', sql: 'SELECT COUNT(*) > 0 AS passed, COUNT(*) AS row_count FROM dim_concept_detail' }
    ], {
      target: { tables: ['dim_concept', 'dim_concept_detail'] },
      execution: buildOfficialScript('fetch_concept_v2.py')
    })
  }
];

class DataTaskSpecService {
  static inferTaskSpec(task) {
    const title = String(task?.title || '');
    for (const preset of PRESETS) {
      if (preset.match.test(title)) {
        return preset.build(title);
      }
    }
    return null;
  }

  static mergeTaskSpec(runtimeSpec, canonicalSpec) {
    if (!canonicalSpec) return runtimeSpec || null;
    if (!runtimeSpec || typeof runtimeSpec !== 'object') return canonicalSpec;
    const mergedValidation = canonicalSpec.validation || runtimeSpec.validation || null;
    return {
      ...runtimeSpec,
      ...canonicalSpec,
      target: canonicalSpec.target || runtimeSpec.target || null,
      checks: canonicalSpec.checks || runtimeSpec.checks || [],
      execution: canonicalSpec.execution || runtimeSpec.execution || null,
      validation: normalizeSourceProbes(mergedValidation),
      metadata: {
        ...(runtimeSpec.metadata || {}),
        ...(canonicalSpec.metadata || {}),
        spec_source: canonicalSpec.metadata?.spec_source || 'preset'
      }
    };
  }

  static getEffectiveTaskSpec(task) {
    const runtimeSpec = task?.task_spec && typeof task.task_spec === 'object' ? task.task_spec : null;
    const canonicalSpec = this.inferTaskSpec(task);
    return this.mergeTaskSpec(runtimeSpec, canonicalSpec);
  }

  static shouldPersistCanonicalSpec(task) {
    return Boolean(this.inferTaskSpec(task));
  }

  static buildRuntimeTaskSpec(task) {
    return this.getEffectiveTaskSpec(task);
  }

  static getOfficialExecution(task, options = {}) {
    const execution = this.getEffectiveTaskSpec(task)?.execution || null;
    if (!execution) return null;

    const env = options.env && typeof options.env === 'object' ? options.env : null;
    if (!env || Object.keys(env).length === 0) {
      return execution;
    }

    return {
      ...execution,
      command: withShellEnv(execution.command, env)
    };
  }

  static getValidationOptions(task) {
    return this.getEffectiveTaskSpec(task)?.validation || null;
  }

  static looksLikeDataTask(task) {
    if (this.getEffectiveTaskSpec(task)) return true;
    const text = `${task?.title || ''} ${task?.description || ''}`.toLowerCase();
    return /(同步|daily_|tushare|duckdb|sqlite|stock\.db|moneyflow|margin|top_list|adj_factor|hsgt|dividend|index_daily|concept)/.test(text);
  }

  static buildAcceptanceCriteria(title, spec) {
    const targetDesc = Array.isArray(spec?.target?.tables)
      ? spec.target.tables.join(', ')
      : (spec?.target?.table || '目标表');
    return [
      `完成《${title}》后，必须把结果写入 ${spec?.path || '目标数据库'} 的 ${targetDesc}。`,
      spec?.execution?.scriptPath ? `优先执行正式脚本 ${spec.execution.scriptPath}，不要临时生成替代脚本。` : null,
      '提交完成时需说明最新日期、最新日期行数和异常项。',
      '只有 task_spec 中的库校验 SQL 全部通过，任务才能进入 completed。'
    ].filter(Boolean).join('\n');
  }
}

module.exports = DataTaskSpecService;
