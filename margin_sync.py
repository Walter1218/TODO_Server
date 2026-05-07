"""
每日融资融券数据增量同步脚本
使用 DuckDB 管理数据，支持增量更新
"""
import os
import sys
import datetime
import duckdb
import pandas as pd
import tushare as ts

# 配置
DUCKDB_PATH = "tushare_margin.duckdb"
TABLE_NAME = "fact_margin"
TOKEN = os.getenv("TUSHARE_TOKEN", "")

# 如果没有设置token，尝试读取配置文件
if not TOKEN:
    config_path = os.path.expanduser("~/.tushare_token")
    if os.path.exists(config_path):
        with open(config_path) as f:
            TOKEN = f.read().strip()

if not TOKEN:
    print("错误: 未设置 TUSHARE_TOKEN")
    sys.exit(1)

def get_last_trade_date(conn):
    """获取数据库中最近一个交易日期"""
    try:
        result = conn.execute(f"SELECT MAX(trade_date) FROM {TABLE_NAME}").fetchone()
        if result and result[0]:
            return result[0]
    except:
        pass
    return None

def get_previous_trade_date():
    """获取上一个交易日（简化：T-1）"""
    today = datetime.date.today()
    # 简单处理：返回昨天的 YYYYMMDD 格式
    yesterday = today - datetime.timedelta(days=1)
    return yesterday.strftime("%Y%m%d")

def create_table_if_not_exists(conn):
    """创建数据表"""
    sql = f"""
    CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
        trade_date VARCHAR,
        ts_code VARCHAR,
        name VARCHAR,
        close DECIMAL(10, 2),
        margin_balance DECIMAL(20, 2),
        margin_balance_rate DECIMAL(10, 4),
        margin_buy DECIMAL(20, 2),
        margin_buy_rate DECIMAL(10, 4),
        short_balance DECIMAL(20, 2),
        short_balance_rate DECIMAL(10, 4),
        short_buy DECIMAL(20, 2),
        short_sell DECIMAL(20, 2),
        short_buy_rate DECIMAL(10, 4),
        short_sell_rate DECIMAL(10, 4),
        update_date DATE,
        PRIMARY KEY (trade_date, ts_code)
    )
    """
    conn.execute(sql)

def fetch_margin_data(start_date, end_date):
    """从 tushare 获取融资融券数据"""
    ts.set_token(TOKEN)
    pro = ts.pro_api()
    
    all_data = []
    # tushare 单次最多返回 5000 条，我们分批获取
    df = pro.margin(start_date=start_date, end_date=end_date)
    
    if df is not None and len(df) > 0:
        all_data.append(df)
    
    if all_data:
        result = pd.concat(all_data, ignore_index=True)
        return result
    return pd.DataFrame()

def sync_data():
    """执行数据同步"""
    print(f"开始同步融资融券数据...")
    print(f"目标数据库: {DUCKDB_PATH}")
    print(f"Token: {TOKEN[:10]}...")
    
    # 连接到 DuckDB
    conn = duckdb.connect(DUCKDB_PATH)
    
    try:
        # 创建表
        create_table_if_not_exists(conn)
        
        # 获取最后交易日期
        last_date = get_last_trade_date(conn)
        print(f"数据库最新日期: {last_date}")
        
        # 确定同步范围
        if last_date:
            start_date = last_date
        else:
            # 首次同步，下载最近一年的数据
            start_date = (datetime.date.today() - datetime.timedelta(days=365)).strftime("%Y%m%d")
        
        end_date = get_previous_trade_date()
        print(f"同步范围: {start_date} - {end_date}")
        
        # 获取数据
        df = fetch_margin_data(start_date, end_date)
        
        if df.empty:
            print("未获取到新数据")
            return
        
        print(f"获取到 {len(df)} 条新数据")
        
        # 数据预处理
        df['update_date'] = datetime.date.today()
        
        # 使用 staging 表进行 swap 更新
        staging_table = f"{TABLE_NAME}_staging"
        
        # 创建临时表
        conn.execute(f"DROP TABLE IF EXISTS {staging_table}")
        conn.execute(f"CREATE TABLE {staging_table} AS SELECT * FROM {TABLE_NAME} WHERE 1=0")
        
        # 插入历史数据
        if last_date:
            conn.execute(f"INSERT INTO {staging_table} SELECT * FROM {TABLE_NAME}")
        
        # 合并新数据（upsert 逻辑）
        # 先删除有冲突的记录
        new_records = df[~df['ts_code'].isin(
            conn.execute(f"SELECT ts_code FROM {TABLE_NAME} WHERE trade_date >= '{start_date}'").fetchdf()['ts_code']
        )] if last_date else df
        
        if len(new_records) == 0 and last_date:
            print("没有新数据需要插入")
        else:
            # 直接插入所有数据到 staging 表（包含历史+新数据）
            # 先清空 staging 表
            conn.execute(f"DELETE FROM {staging_table}")
            
            # 插入所有历史数据
            if last_date:
                conn.execute(f"INSERT INTO {staging_table} SELECT * FROM {TABLE_NAME}")
            
            # 追加新数据
            conn.execute(f"INSERT INTO {staging_table} SELECT * FROM df")
            
            # 交换表
            conn.execute(f"ALTER TABLE {TABLE_NAME} SET SCHEMA main")
            conn.execute(f"ALTER TABLE {staging_table} SET SCHEMA main")
            
            # 使用 SWAP
            conn.execute(f"CALL swap_tables('{TABLE_NAME}', '{staging_table}')")
        
        # 验证结果
        final_count = conn.execute(f"SELECT COUNT(*) FROM {TABLE_NAME}").fetchone()[0]
        latest_date = conn.execute(f"SELECT MAX(trade_date) FROM {TABLE_NAME}").fetchone()[0]
        
        print(f"同步完成!")
        print(f"总记录数: {final_count}")
        print(f"最新日期: {latest_date}")
        
    finally:
        conn.close()

if __name__ == "__main__":
    sync_data()
