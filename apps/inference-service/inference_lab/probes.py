from pathlib import Path
from typing import Annotated
import torch
from pydantic import Field
from .contracts import StrictModel, Segment, Id, Probability
from .model import Embedder, INPUT_FORMAT


class Evaluation(StrictModel):
    precision: Probability
    recall: Probability
    false_positive_rate: Probability
    threshold: Probability
    train_size: Annotated[int, Field(gt=0)]
    test_size: Annotated[int, Field(gt=0)]
    true_negatives: Annotated[int, Field(ge=0)]
    false_positives: Annotated[int, Field(ge=0)]
    false_negatives: Annotated[int, Field(ge=0)]
    true_positives: Annotated[int, Field(ge=0)]


class ProbeArtifact(StrictModel):
    schemaVersion: Annotated[int, Field(ge=1, le=1)] = 1
    probeId: Segment
    version: Segment
    modelVersion: Id
    inputFormat: str
    weights: Annotated[list[float], Field(min_length=1, max_length=4096)]
    bias: float
    metrics: Evaluation
    datasetSha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
    seed: int

    @property
    def key(self) -> str:
        return f"{self.probeId}:{self.version}"


class ProbeBank:
    def __init__(self, embedder: Embedder, artifacts: list[ProbeArtifact]):
        if not 1 <= len(artifacts) <= 128:
            raise ValueError("load between 1 and 128 probe artifacts")
        self.embedder = embedder
        self.indices = {p.key: i for i, p in enumerate(artifacts)}
        if len(self.indices) != len(artifacts):
            raise ValueError("duplicate probe version")
        for p in artifacts:
            if (
                p.modelVersion != embedder.model_version
                or p.inputFormat != INPUT_FORMAT
                or len(p.weights) != embedder.dimension
            ):
                raise ValueError("probe incompatible with model, input format or dimension")
        self.weights = torch.tensor([p.weights for p in artifacts], dtype=torch.float32)
        self.biases = torch.tensor([p.bias for p in artifacts], dtype=torch.float32)
        if not torch.isfinite(self.weights).all() or not torch.isfinite(self.biases).all():
            raise ValueError("nonfinite probe parameters")

    @torch.inference_mode()
    def score(self, text: str, ids: list[str]) -> dict[str, float]:
        indices = [self.indices[key] for key in ids]  # resolve before expensive inference
        vector = self.embedder.embed(text)
        logits = self.weights @ vector + self.biases
        scores = torch.sigmoid(logits)
        if not torch.isfinite(logits).all() or not torch.isfinite(scores).all():
            raise ValueError("nonfinite inference result")
        return {key: float(scores[i]) for key, i in zip(ids, indices, strict=True)}


def load_artifacts(directory: Path) -> list[ProbeArtifact]:
    paths = sorted(directory.glob("*.json"))
    if len(paths) > 128:
        raise ValueError("too many probe artifacts")
    result = []
    for path in paths:
        if path.stat().st_size > 1_000_000:
            raise ValueError("probe artifact too large")
        result.append(ProbeArtifact.model_validate_json(path.read_bytes()))
    return result
