const fs = require('fs');
const CompletionReportBuilder = require('../src/services/CompletionReportBuilder');
const ValidationPolicyService = require('../src/services/ValidationPolicyService');

describe('ValidationPolicyService inspection fallback', () => {
  const existsSyncSpy = jest.spyOn(fs, 'existsSync');
  const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
  const storeReportSpy = jest.spyOn(CompletionReportBuilder, 'storeReport').mockImplementation(() => {});

  beforeEach(() => {
    existsSyncSpy.mockImplementation((targetPath) => String(targetPath).includes('daily_inspection_2026-05-08.json'));
    readFileSyncSpy.mockImplementation((targetPath) => {
      if (!String(targetPath).includes('daily_inspection_2026-05-08.json')) {
        throw new Error(`unexpected path: ${targetPath}`);
      }
      return JSON.stringify({
      timestamp: '2026-05-08',
      summary: { total: 15, ok: 11, warning: 2, error: 0, static: 2 },
      results: [
        { label: '分红数据', status: 'warning', max_ann_date: '20260501', days_old: 7, null_rate: 0.36 },
        { label: '财务指标', status: 'warning', max_date: '20260331', days_old: 8, null_rate: 0 }
      ],
      errors: []
      });
    });
  });

  afterEach(() => {
    existsSyncSpy.mockReset();
    readFileSyncSpy.mockReset();
    storeReportSpy.mockClear();
  });

  test('builds inspection completion report from daily inspection json when completion report is missing', () => {
    const task = {
      id: 'inspection-task-1',
      agent_id: 'hermes-default',
      title: '每日 DuckDB 数据仓库巡检',
      description: '巡检任务',
      task_category: 'inspection',
      created_at: '2026-05-08 00:00:06',
      completion_report: null
    };

    const result = ValidationPolicyService.validate(task);
    expect(result.applied).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.reason).toContain('巡检报告结构完整');
  });
});
