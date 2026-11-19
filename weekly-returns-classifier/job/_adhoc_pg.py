import pg8000.native as pg
import os, json, datetime as dt

db = pg.Connection(user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"], host=os.environ["PGHOST"],
                   port=int(os.environ["PGPORT"]), database=os.environ["PGDATABASE"])

sql = """
  select o.id, o.name, o.email, o.customer_email, o.created_at, o.financial_status, o.cancelled_at, o.fulfillment_status, o.tags,
         (select min(f.delivered_at) from order_fulfillments f where f.order_id = o.id) as delivered
  from orders o
  where o.test is not true
    and o.name like '#CC%%'
    and exists (select 1 from order_line_items l where l.order_id = o.id and l.title ilike '%%Core One Pro%%')
    and exists (select 1 from order_fulfillments f where f.order_id = o.id and f.delivered_at is not null
                and f.delivered_at >= '2026-08-03' and f.delivered_at < '2026-10-05')
  order by delivered
"""
rows = db.run(sql)
cols = ["id","name","email","customer_email","created_at","financial_status","cancelled_at","fulfillment_status","tags","delivered"]
out = [dict(zip(cols, r)) for r in rows]
for r in out:
    for k in ("created_at","cancelled_at","delivered"):
        if r[k] is not None:
            r[k] = r[k].isoformat()
print(json.dumps(out, default=str))
db.close()
