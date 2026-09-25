import psycopg2
import os
from dotenv import load_dotenv

load_dotenv('../.env')

def get_conn():
    return psycopg2.connect(os.getenv("DATABASE_URL"))

def fetch_recent_logs(limit=200):
    conn = None
    cur = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("""
            SELECT "cacheHit", "similarityScore", "alphaUsed", "thresholdUsed", "latencyMs"
            FROM "TelemetryLog"
            ORDER BY "createdAt" DESC
            LIMIT %s
            """, (limit,))
        rows = cur.fetchall()
        return rows
    finally:
        if cur:
            cur.close()
        if conn:
            conn.close()