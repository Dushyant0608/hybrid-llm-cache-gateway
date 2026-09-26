import time
from db import fetch_recent_logs
from bayesian import run_optimization

MIN_LOGS = 30
CYCLE_SECONDS = 1800

def run_cycle():
    logs= fetch_recent_logs()
    if len(logs) < MIN_LOGS:
        print(f"only {len(logs)} logs, skipping cycle")
        return
    
    alpha, threshold = run_optimization()
    print(f"updated config: alpha={alpha}, threshold={threshold}")

if __name__ == "__main__":
    while True:
        run_cycle()
        time.sleep(CYCLE_SECONDS)