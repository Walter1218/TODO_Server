import json
import os
import sqlite3
import time

import duckdb


DUCKDB_CHECKS = [
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "daily_quote", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_adj_factor", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_dividend", "record_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_hk_hold", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_hsgt_top10", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_stk_limit", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "index_daily", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_moneyflow_deprecated_20240717", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/a_share_warehouse.duckdb", "fact_block_trade_deprecated_20241101", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/margin.duckdb", "fact_margin", "trade_date"),
    ("/Users/onetwo/.openclaw/workspace/tushare_moneyflow.duckdb", "moneyflow", "trade_date"),
    ("/Users/onetwo/a_share_warehouse/tushare_toplist.duckdb", "fact_top_list", "trade_date"),
    ("/Users/onetwo/tushare_block_trade_v2.duckdb", "block_trade", "trade_date"),
]

SQLITE_CHECKS = [
    ("/Users/onetwo/.openclaw/workspace/stock.db", ["daily_quote", "daily_basic", "adj_factor"]),
    ("/Users/onetwo/stock.db", ["daily_quote", "daily_basic", "adj_factor"]),
    ("/Users/onetwo/Documents/trae_projects/test/TODO_Server/stock.db", ["daily_quote", "daily_basic", "adj_factor"]),
]


def fmt_mtime(path):
    stat = os.stat(path)
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime))


def query_duckdb(path, table, column):
    item = {"path": path, "table": table, "column": column, "exists": os.path.exists(path)}
    if not item["exists"]:
        return item

    item["mtime"] = fmt_mtime(path)
    item["size"] = os.path.getsize(path)

    try:
        conn = duckdb.connect(path, read_only=True)
        item["count"] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        item["min"] = str(conn.execute(f"SELECT MIN({column}) FROM {table}").fetchone()[0])
        item["max"] = str(conn.execute(f"SELECT MAX({column}) FROM {table}").fetchone()[0])
        latest = conn.execute(f"SELECT MAX({column}) FROM {table}").fetchone()[0]
        if latest is not None:
            item["latest_date_rows"] = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE {column} = ?",
                [latest]
            ).fetchone()[0]
    except Exception as exc:
        item["error"] = str(exc)

    return item


def query_sqlite(path, tables):
    item = {"path": path, "exists": os.path.exists(path)}
    if not item["exists"]:
        return item

    item["mtime"] = fmt_mtime(path)
    item["size"] = os.path.getsize(path)

    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        existing = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        item["tables"] = sorted(existing)
        item["checks"] = []
        for table in tables:
            if table not in existing:
                item["checks"].append({"table": table, "exists": False})
                continue
            row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
            item["checks"].append({"table": table, "exists": True, "count": row[0]})
    except Exception as exc:
        item["error"] = str(exc)

    return item


def main():
    output = {
        "duckdb": [query_duckdb(path, table, column) for path, table, column in DUCKDB_CHECKS],
        "sqlite": [query_sqlite(path, tables) for path, tables in SQLITE_CHECKS],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
