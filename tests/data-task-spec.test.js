const DataTaskSpecService = require('../src/services/DataTaskSpecService');

describe('DataTaskSpecService official execution', () => {
  test('builds official script command with token injection and no run_index sourcing', () => {
    const task = {
      title: '每日涨跌停数据增量同步（stk_limit）'
    };

    const execution = DataTaskSpecService.getOfficialExecution(task);

    expect(execution).toBeTruthy();
    expect(execution.command).toContain("TOKEN_FILE='");
    expect(execution.command).toContain('export TUSHARE_API_TOKEN=');
    expect(execution.command).toContain('export TUSHARE_TOKEN="$TUSHARE_API_TOKEN"');
    expect(execution.command).toContain('/opt/anaconda3/bin/python');
    expect(execution.command).toContain('/Users/onetwo/.openclaw/workspace/tushare_warehouse/scripts/fetch_stk_limit.py');
    expect(execution.command).not.toContain('source ');
    expect(execution.requirements.tokenPath).toContain('/Users/onetwo/.openclaw/workspace/stock_backfill/.token');
  });

  test('normalizes trade_date comparisons for date-typed DuckDB tables', () => {
    const spec = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日涨跌停数据增量同步（stk_limit）'
    });

    expect(spec.checks[0].sql).toContain("REPLACE(CAST(MAX(trade_date) AS VARCHAR), '-', '')");
    expect(spec.checks[1].sql).toContain("REPLACE(CAST(trade_date AS VARCHAR), '-', '')");
  });

  test('matches full daily collection before generic daily_quote preset', () => {
    const spec = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日 A股日线数据全量采集（daily_quote + daily_basic）'
    });
    const execution = DataTaskSpecService.getOfficialExecution({
      title: '每日 A股日线数据全量采集（daily_quote + daily_basic）'
    });

    expect(spec.target.tables).toEqual(['daily_quote', 'daily_basic']);
    expect(spec.checks).toHaveLength(4);
    expect(execution).toBeTruthy();
    expect(execution.scriptPath).toContain('fetch_daily_tushare.py');
    expect(execution.command).toContain('--days');
    expect(execution.command).toContain("'\\''1'\\'''");
  });

  test('uses same-day validation and source probe for lagging market close tasks', () => {
    const stkLimit = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日涨跌停数据增量同步（stk_limit）'
    });
    const topList = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日龙虎榜数据增量同步（top_list）'
    });
    const blockTrade = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日大宗交易数据增量同步（block_trade）'
    });
    const hsgt = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日沪深港通数据增量同步（hsgt）'
    });

    expect(stkLimit.checks[0].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');
    expect(topList.checks[0].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');
    expect(blockTrade.checks[0].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');
    expect(hsgt.checks[0].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');
    expect(hsgt.checks[2].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');

    expect(stkLimit.validation.sourceProbe.api).toBe('stk_limit');
    expect(stkLimit.validation.sourceProbe.lagDays).toBe(0);
    expect(topList.validation.sourceProbe.api).toBe('top_list');
    expect(topList.validation.sourceProbe.lagDays).toBe(0);
    expect(blockTrade.validation.sourceProbe.api).toBe('block_trade');
    expect(blockTrade.validation.sourceProbe.lagDays).toBe(0);
    expect(hsgt.validation.sourceProbe.api).toBe('hk_hold');
    expect(hsgt.validation.sourceProbe.lagDays).toBe(0);
    expect(hsgt.validation.sourceProbes).toHaveLength(1);
    expect(hsgt.validation.sourceProbes[0].api).toBe('hk_hold');
  });

  test('overrides stale runtime task_spec with canonical preset on read', () => {
    const spec = DataTaskSpecService.getEffectiveTaskSpec({
      title: '每日龙虎榜数据增量同步（top_list）',
      task_spec: {
        kind: 'data_task',
        engine: 'duckdb',
        path: '/tmp/legacy.duckdb',
        target: { table: 'legacy_top_list', dateColumn: 'trade_date' },
        checks: [{
          label: 'legacy_latest_date',
          sql: "SELECT CAST(MAX(trade_date) AS VARCHAR) >= strftime(CURRENT_DATE - INTERVAL 1 DAY, '%Y%m%d') AS passed FROM legacy_top_list"
        }]
      }
    });

    expect(spec.path).toContain('tushare_toplist.duckdb');
    expect(spec.target.table).toBe('fact_top_list');
    expect(spec.checks[0].sql).toContain('CURRENT_DATE - INTERVAL 0 DAY');
    expect(spec.validation.sourceProbe.api).toBe('top_list');
  });


  test('injects explicit task binding env for official execution', () => {
    const execution = DataTaskSpecService.getOfficialExecution(
      { id: 'task-123', title: '每日 A股数据同步到 SQLite stock.db' },
      {
        env: {
          TODO_TASK_ID: 'task-123',
          TODO_AGENT_ID: 'hermes-default'
        }
      }
    );

    expect(execution).toBeTruthy();
    expect(execution.command).toContain('export TODO_TASK_ID=');
    expect(execution.command).toContain('task-123');
    expect(execution.command).toContain('export TODO_AGENT_ID=');
    expect(execution.command).toContain('hermes-default');
    expect(execution.command).toContain('daily_update_wrapper.py');
  });
});
