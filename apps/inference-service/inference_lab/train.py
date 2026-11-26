"""Train an immutable linear probe; held-out rows never fit the estimator."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix, precision_score, recall_score
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from .model import INPUT_FORMAT, Embedder, load_embedder
from .probes import Evaluation, ProbeArtifact


def tool_text(prompt: str) -> str:
    # Same field order and compact JSON format as the guardrail's tool-text encoder.
    return json.dumps({"tool":"transfer_money", "arguments":{"amount":500,"note":"ordinary"},
                       "context":{"prompt":prompt}}, ensure_ascii=False, separators=(",", ":"))


def read_dataset(path: Path):
    raw = path.read_bytes()
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    texts = [r["text"].strip() for r in rows]
    if len(set(texts)) != len(texts) or any(not t for t in texts):
        raise ValueError("dataset has duplicate or empty text")
    labels = np.array([int(r["label"]) for r in rows])
    if set(labels) != {0, 1} or min(np.bincount(labels)) < 5:
        raise ValueError("need at least five samples of each binary class")
    return texts, labels, hashlib.sha256(raw).hexdigest()


def train(embedder: Embedder, dataset: Path, probe_id: str, version: str,
          seed: int = 42, threshold: float = 0.5) -> ProbeArtifact:
    texts, y, digest = read_dataset(dataset)
    train_idx, test_idx = train_test_split(np.arange(len(y)), test_size=0.25,
                                           random_state=seed, stratify=y)
    x = np.stack([embedder.embed(tool_text(text)).cpu().numpy() for text in texts])
    scaler = StandardScaler().fit(x[train_idx])
    classifier = LogisticRegression(random_state=seed, max_iter=1000).fit(scaler.transform(x[train_idx]), y[train_idx])
    predicted = (classifier.predict_proba(scaler.transform(x[test_idx]))[:, 1] >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y[test_idx], predicted, labels=[0, 1]).ravel()
    # Fold normalization into one affine operation for serving.
    weights = classifier.coef_[0] / scaler.scale_
    bias = classifier.intercept_[0] - np.dot(weights, scaler.mean_)
    metrics = Evaluation(precision=float(precision_score(y[test_idx], predicted, zero_division=0)),
        recall=float(recall_score(y[test_idx], predicted, zero_division=0)), false_positive_rate=float(fp / (fp + tn)),
        threshold=threshold, train_size=len(train_idx), test_size=len(test_idx), true_negatives=int(tn),
        false_positives=int(fp), false_negatives=int(fn), true_positives=int(tp))
    return ProbeArtifact(probeId=probe_id, version=version, modelVersion=embedder.model_version,
        inputFormat=INPUT_FORMAT, weights=weights.tolist(), bias=float(bias), metrics=metrics,
        datasetSha256=digest, seed=seed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=Path("data/toy_jailbreak.csv"))
    parser.add_argument("--probe-id", default="jailbreak")
    parser.add_argument("--version", default="1.0.0")
    parser.add_argument("--out", type=Path, default=Path("artifacts"))
    args = parser.parse_args()
    model = load_embedder()
    try:
        artifact = train(model, args.dataset, args.probe_id, args.version)
        args.out.mkdir(parents=True, exist_ok=True)
        path = args.out / f"{artifact.probeId}-{artifact.version}.json"
        with path.open("x", encoding="utf-8") as file:
            file.write(artifact.model_dump_json(indent=2) + "\n")
        print(artifact.metrics.model_dump_json(indent=2))
        print(f"Saved immutable artifact: {path}")
    finally:
        model.close()


if __name__ == "__main__":
    main()
