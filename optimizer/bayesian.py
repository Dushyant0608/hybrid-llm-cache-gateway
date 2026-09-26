from skopt import gp_minimize
from skopt.space import Real
from db import fetch_recent_logs
from scorer import simulate_score
from redis_client import set_config

space = [
    Real(0.0, 1.0, name="alpha"),
    Real(0.5, 0.95, name="threshold")
]

def objective(params):
    alpha, threshold = params
    logs = fetch_recent_logs()
    score = simulate_score(logs, alpha, threshold)
    return -score

def run_optimization():
    result = gp_minimize(objective, space, n_calls=15, random_state=0)
    best_alpha, best_threshold = result.x
    set_config(best_alpha, best_threshold)
    return best_alpha, best_threshold