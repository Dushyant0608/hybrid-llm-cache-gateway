def calculate_hit_rate(logs):
    if not logs:
        return 0
    hits = sum(1 for log in logs if log[0])
    return hits / len(logs)

def calculate_avg_latency(logs):
    if not logs:
        return 0
    return sum(log[4] for log in logs) / len(logs)

def score_performance(logs):
    hit_rate = calculate_hit_rate(logs)
    avg_latency = calculate_avg_latency(logs)
    return hit_rate - (avg_latency / 10000)