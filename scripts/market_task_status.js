const { getDb } = require('../src/db');

const db = getDb();

const TITLES = [
  '每日 A股数据同步到 SQLite stock.db',
  '每日大宗交易数据增量同步（block_trade）',
  '每日沪深港通数据增量同步（hsgt）',
  '每日复权因子数据增量同步（adj_factor）',
  '每日分红数据增量同步（dividend）',
  '每日龙虎榜数据增量同步（top_list）',
  '每日资金流向数据增量同步（moneyflow）',
  '每日 A股日线数据全量采集（daily_quote + daily_basic）',
  '每日涨跌停数据增量同步（stk_limit）',
  '每日指数日线数据增量同步（index_daily）'
];

const rows = db.prepare(`
  SELECT
    id,
    title,
    status,
    parent_id,
    is_template,
    attempt_count,
    max_attempts,
    last_heartbeat,
    heartbeat_step,
    created_at,
    updated_at
  FROM todos
  WHERE title IN (${TITLES.map(() => '?').join(',')})
  ORDER BY title, datetime(created_at) DESC
`).all(...TITLES);

const today = new Date().toISOString().slice(0, 10);

const grouped = new Map();
for (const row of rows) {
  if (!grouped.has(row.title)) grouped.set(row.title, []);
  grouped.get(row.title).push(row);
}

const output = [];
for (const title of TITLES) {
  const items = grouped.get(title) || [];
  const todayItems = items.filter(item => String(item.created_at || '').slice(0, 10) === today);
  const staleItems = items.filter(item => String(item.created_at || '').slice(0, 10) !== today && !item.is_template);

  output.push({
    title,
    today_count: todayItems.length,
    stale_active_count: staleItems.filter(item => ['pending', 'in_progress', 'blocked', 'pending_validation', 'validating'].includes(item.status)).length,
    today_items: todayItems.slice(0, 5),
    stale_active_items: staleItems
      .filter(item => ['pending', 'in_progress', 'blocked', 'pending_validation', 'validating'].includes(item.status))
      .slice(0, 5)
  });
}

console.log(JSON.stringify(output, null, 2));
