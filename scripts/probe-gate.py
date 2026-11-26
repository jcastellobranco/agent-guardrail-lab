"""Compare held-out FPR for identical evaluation inputs; refuse incomparable runs."""
import argparse
import json
from pathlib import Path

def evaluate(candidate, baseline=None, max_increase=0.05, max_fpr=0.6):
    fpr = candidate['metrics']['false_positive_rate']
    if not 0 <= fpr <= max_fpr:
        raise ValueError(f'Candidate FPR {fpr} exceeds absolute ceiling {max_fpr}')
    if baseline is None:
        return 'Bootstrap absolute ceiling passed; no prior model available.'
    for field in ['datasetSha256', 'seed', 'inputFormat']:
        if candidate[field] != baseline[field]:
            raise ValueError(f'Incomparable evaluation: {field}')
    for field in ['threshold', 'test_size']:
        if candidate['metrics'][field] != baseline['metrics'][field]:
            raise ValueError(f'Incomparable evaluation: {field}')
    previous = baseline['metrics']['false_positive_rate']
    if fpr - previous > max_increase + 1e-12:
        raise ValueError(f'FPR regression: {previous:.3f} -> {fpr:.3f}')
    return f'FPR gate passed: {previous:.3f} -> {fpr:.3f}'

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('candidate', type=Path)
    p.add_argument('--baseline', type=Path)
    p.add_argument('--max-increase', type=float, default=.05)
    p.add_argument('--max-fpr', type=float, default=.6)
    a = p.parse_args()
    baseline = json.loads(a.baseline.read_text()) if a.baseline and a.baseline.exists() else None
    print(evaluate(json.loads(a.candidate.read_text()), baseline, a.max_increase, a.max_fpr))
