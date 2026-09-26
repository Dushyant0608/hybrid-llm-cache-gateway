def simulate_score(logs, alpha, threshold, penalty_weight=1.0):
    if not logs:
        return 0
    
    hits = 0
    false_positives = 0
    total_latency = 0

    for cache_hit, semantic, lexical, should_hit, latency in logs:
        if semantic is None or lexical is None:
            continue

        combined = alpha * semantic + (1 - alpha) * lexical
        would_hit = combined >= threshold

        if would_hit:
            hits += 1

            if should_hit is False:
                false_positives += 1

        total_latency += latency
        
    if hits == 0:
        return -1

    hit_rate = hits / len(logs)
    fp_rate = false_positives / hits
    avg_latency = total_latency / len(logs)

    return hit_rate - (fp_rate * penalty_weight) - (avg_latency / 10000)