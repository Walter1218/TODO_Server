jest.mock('child_process', () => ({
  execFileSync: jest.fn()
}));

const { execFileSync } = require('child_process');
const DataTaskValidationService = require('../src/services/DataTaskValidationService');

describe('DataTaskValidationService', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  test('passes when all task_spec SQL checks pass', () => {
    execFileSync.mockReturnValue(JSON.stringify({
      checks: [
        { label: 'latest_date', passed: true, rows: [{ latest_value: '20260507' }] },
        { label: 'latest_rows', passed: true, rows: [{ latest_rows: '5493' }] }
      ]
    }));

    const result = DataTaskValidationService.validate({
      title: '每日 A股日线数据增量同步（Tushare）',
      task_spec: {
        kind: 'data_task',
        engine: 'duckdb',
        path: '/tmp/test.duckdb',
        checks: [{ label: 'latest_date', sql: 'SELECT 1 AS passed' }]
      }
    });

    expect(result.applied).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.validator).toBe('policy:data_task');
  });

  test('fails when any task_spec SQL check fails', () => {
    execFileSync.mockReturnValue(JSON.stringify({
      checks: [
        { label: 'latest_date', passed: false, rows: [{ latest_value: '20260430' }] }
      ]
    }));

    const result = DataTaskValidationService.validate({
      title: '每日融资融券数据增量同步（margin）',
      task_spec: {
        kind: 'data_task',
        engine: 'duckdb',
        path: '/tmp/test.duckdb',
        checks: [{ label: 'latest_date', sql: 'SELECT 0 AS passed' }]
      }
    });

    expect(result.applied).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('latest_date');
  });

  test('adapts sqlite interval sql before validation', () => {
    execFileSync.mockReturnValue(JSON.stringify({
      checks: [
        { label: 'fact_daily_latest_date', passed: true, rows: [{ latest_value: '2026-05-07' }] }
      ]
    }));

    DataTaskValidationService.validate({
      title: '每日 A股数据同步到 SQLite stock.db',
      task_spec: {
        kind: 'data_task',
        engine: 'sqlite',
        path: '/tmp/test.sqlite',
        checks: [{
          label: 'fact_daily_latest_date',
          sql: "SELECT REPLACE(CAST(MAX(date) AS VARCHAR), '-', '') >= strftime(CURRENT_DATE - INTERVAL 1 DAY, '%Y%m%d') AS passed FROM fact_daily"
        }]
      }
    });

    const payload = JSON.parse(execFileSync.mock.calls[0][2].input);
    expect(payload.checks[0].sql).toContain("strftime('%Y%m%d', 'now', '-1 day')");
    expect(payload.checks[0].sql).not.toContain('INTERVAL 1 DAY');
  });

  test('defers validation when source probe confirms no upstream rows for the day', () => {
    execFileSync
      .mockReturnValueOnce(JSON.stringify({
        checks: [
          { label: 'fact_hk_hold_latest_date', passed: false, rows: [{ latest_value: '2026-05-06' }] }
        ]
      }))
      .mockReturnValueOnce(JSON.stringify({
        rows: 0,
        trade_date: '20260507',
        api: 'hk_hold'
      }));

    const result = DataTaskValidationService.validate({
      title: '每日沪深港通数据增量同步（hsgt）'
    });

    expect(result.applied).toBe(true);
    expect(result.deferred).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.reason).toContain('延期');
    expect(result.source_probe.rows).toBe(0);
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
