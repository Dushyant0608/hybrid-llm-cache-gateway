import redis
import json
import os
from dotenv import load_dotenv

load_dotenv("../.env")

r = redis.Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379"))

def get_config():
    data = r.get("cache:config")
    if data is None:
        return None
    return json.loads(data)

def set_config(alpha, threshold):
    r.set("cache:config", json.dumps({
        "alpha": alpha,
        "threshold": threshold
    }))