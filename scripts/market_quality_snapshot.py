#!/usr/bin/env python3
import json
import sqlite3

import duckdb


items = []


def add_duck(task, db_path, queries):
    result = {"task": task, "db_path": db_path}
    try:
        conn = duckdb.connect(db_path, read_only=True)
        for key, sql in queries.items():
            result[key] = conn.execute(sql).fetchall()
        conn.close()
        result["ok"] = True
    except Exception as exc:
        result["ok"] = False
        result["error"] = repr(exc)
    items.append(result)


add_duck(
    "block_trade",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_block_trade_v2.duckdb",
    {
        "range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM block_trade",
        "latest_date_rows": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM block_trade WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM block_trade)",
        "nulls": "SELECT SUM(CASE WHEN ts_code IS NULL THEN 1 ELSE 0 END) AS null_ts_code, SUM(CASE WHEN trade_date IS NULL THEN 1 ELSE 0 END) AS null_trade_date FROM block_trade",
    },
)

add_duck(
    "hsgt",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_hsgt.duckdb",
    {
        "hk_hold_range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM fact_hk_hold",
        "top10_range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM fact_hsgt_top10",
        "hk_hold_latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM fact_hk_hold WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM fact_hk_hold)",
        "top10_latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM fact_hsgt_top10 WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM fact_hsgt_top10)",
        "nulls": "SELECT SUM(CASE WHEN trade_date IS NULL THEN 1 ELSE 0 END) AS null_trade_date FROM fact_hk_hold",
    },
)

add_duck(
    "adj_factor",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_adj_factor.duckdb",
    {
        "range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM fact_adj_factor",
        "latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM fact_adj_factor WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM fact_adj_factor)",
        "nulls": "SELECT SUM(CASE WHEN trade_date IS NULL THEN 1 ELSE 0 END) AS null_trade_date, SUM(CASE WHEN adj_factor IS NULL THEN 1 ELSE 0 END) AS null_adj_factor FROM fact_adj_factor",
    },
)

add_duck(
    "dividend",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_dividend.duckdb",
    {
        "range": "SELECT CAST(MIN(ann_date) AS VARCHAR), CAST(MAX(ann_date) AS VARCHAR), COUNT(*) FROM fact_dividend",
        "latest": "SELECT CAST(MAX(ann_date) AS VARCHAR) AS latest_ann_date, COUNT(*) AS rows_on_latest FROM fact_dividend WHERE CAST(ann_date AS VARCHAR)=(SELECT CAST(MAX(ann_date) AS VARCHAR) FROM fact_dividend)",
        "nulls": "SELECT SUM(CASE WHEN ann_date IS NULL THEN 1 ELSE 0 END) AS null_ann_date, SUM(CASE WHEN ts_code IS NULL THEN 1 ELSE 0 END) AS null_ts_code FROM fact_dividend",
    },
)

add_duck(
    "top_list",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_toplist.duckdb",
    {
        "range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM fact_top_list",
        "latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM fact_top_list WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM fact_top_list)",
        "nulls": "SELECT SUM(CASE WHEN trade_date IS NULL THEN 1 ELSE 0 END) AS null_trade_date, SUM(CASE WHEN ts_code IS NULL THEN 1 ELSE 0 END) AS null_ts_code FROM fact_top_list",
    },
)

add_duck(
    "moneyflow",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_moneyflow.duckdb",
    {
        "range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM fact_moneyflow",
        "latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM fact_moneyflow WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM fact_moneyflow)",
        "nulls": "SELECT SUM(CASE WHEN trade_date IS NULL THEN 1 ELSE 0 END) AS null_trade_date, SUM(CASE WHEN ts_code IS NULL THEN 1 ELSE 0 END) AS null_ts_code FROM fact_moneyflow",
    },
)

add_duck(
    "daily_quote+daily_basic",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_daily.duckdb",
    {
        "daily_quote_range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM daily_quote",
        "daily_basic_range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM daily_basic",
        "daily_quote_latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM daily_quote WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM daily_quote)",
        "daily_basic_latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM daily_basic WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM daily_basic)",
        "basic_quality": "SELECT COUNT(*) AS turnover_nonnull_rows FROM daily_basic WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM daily_basic) AND turnover_rate IS NOT NULL",
    },
)

add_duck(
    "stk_limit",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_stklimit.duckdb",
    {
        "range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM fact_stk_limit",
        "latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM fact_stk_limit WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM fact_stk_limit)",
    },
)

add_duck(
    "index_daily",
    "/Users/onetwo/.openclaw/workspace/tushare_warehouse/data/tushare_index_daily.duckdb",
    {
        "range": "SELECT CAST(MIN(trade_date) AS VARCHAR), CAST(MAX(trade_date) AS VARCHAR), COUNT(*) FROM index_daily",
        "latest": "SELECT CAST(MAX(trade_date) AS VARCHAR) AS latest_date, COUNT(*) AS rows_on_latest FROM index_daily WHERE CAST(trade_date AS VARCHAR)=(SELECT CAST(MAX(trade_date) AS VARCHAR) FROM index_daily)",
    },
)

stock = {"task": "stock.db", "db_path": "/Users/onetwo/.openclaw/workspace/stock_backfill/data/stock.db"}
try:
    conn = sqlite3.connect("/Users/onetwo/.openclaw/workspace/stock_backfill/data/stock.db")
    cur = conn.cursor()
    cur.execute("SELECT MAX(date), COUNT(*) FROM fact_daily WHERE date=(SELECT MAX(date) FROM fact_daily)")
    stock["fact_daily_latest"] = cur.fetchall()
    cur.execute("SELECT MIN(date), MAX(date), COUNT(*) FROM fact_daily")
    stock["fact_daily_range"] = cur.fetchall()
    conn.close()
    stock["ok"] = True
except Exception as exc:
    stock["ok"] = False
    stock["error"] = repr(exc)
items.append(stock)

print(json.dumps(items, ensure_ascii=False, indent=2))
