import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('../.env')

def get_conn():
    return psycopg2.connect(os.getenv("DATABASE_URL"))

def fetch_recent_logs(limit=200):
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("""
        SELECT "cacheHit", "similarityScore", "alphaUsed", "thresholdUsed", "latencyMs"
        FROM "TelemetryLog"
        ORDER BY "createdAt" DESC
        LIMIT %s
    """, (limit,))
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows