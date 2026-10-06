from skopt import gp_minimize
from skopt.space import Real
from db import fetch_recent_logs
from scorer import simulate_score
from redis_client import set_config

space = [
    Real(0.0, 1.0, name="alpha"),
    Real(0.5, 0.95, name="threshold")
]

def objective(params, penalty_weight=1.0):
    alpha, threshold = params
    logs = fetch_recent_logs()
    score = simulate_score(logs, alpha, threshold, penalty_weight=penalty_weight)
    print(f"  trying alpha={alpha:.3f} threshold={threshold:.3f} -> score={score:.4f}")
    return -score

def run_optimization(penalty_weight=1.0):
    result = gp_minimize(lambda p: objective(p, penalty_weight), space, n_calls=15, random_state=0)
    best_alpha, best_threshold = result.x

    print("\n--- optimization trajectory ---")
    for i, (params, val) in enumerate(zip(result.x_iters, result.func_vals)):
        print(f"iter {i+1}: alpha={params[0]:.3f} threshold={params[1]:.3f} score={-val:.4f}")
    print(f"best: alpha={best_alpha:.3f} threshold={best_threshold:.3f} score={-result.fun:.4f}")

    return best_alpha, best_threshold