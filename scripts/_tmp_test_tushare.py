import tushare as ts
ts.set_token('ec2347644ca1b10d6ed29b67f376cf30e7af41ae2197821fb22cf723')
print('token set ok')
pro = ts.pro_api()
df = pro.hk_hold(ts_code='000001.SZ', start_date='20260501', end_date='20260506')
print(f'rows: {len(df)}')
print(df.head() if len(df) > 0 else 'empty')
