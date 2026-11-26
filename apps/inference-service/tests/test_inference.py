from pathlib import Path
import threading
import torch
from fastapi.testclient import TestClient
import pytest
from inference_lab.api import create_app
from inference_lab.model import HookedEmbedder, InputTooLong, INPUT_FORMAT
from inference_lab.probes import Evaluation, ProbeArtifact, ProbeBank, load_artifacts
from inference_lab.train import train


class FakeEmbedder:
    model_version = "fixture:v1"
    dimension = 2

    def embed(self, text):
        return torch.tensor([float(len(text) % 5), 1.0])


def artifact(probe_id="jailbreak", version="1.0.0", weights=None):
    return ProbeArtifact(
        probeId=probe_id,
        version=version,
        modelVersion="fixture:v1",
        inputFormat=INPUT_FORMAT,
        weights=weights or [1.0, -1.0],
        bias=0.0,
        datasetSha256="0" * 64,
        seed=42,
        metrics=Evaluation(
            precision=0.0,
            recall=0.0,
            false_positive_rate=0.0,
            threshold=0.5,
            train_size=8,
            test_size=4,
            true_negatives=2,
            false_positives=0,
            false_negatives=2,
            true_positives=0,
        ),
    )


def test_matrix_scores_and_version_selection():
    bank = ProbeBank(FakeEmbedder(), [artifact(), artifact("other", weights=[-1.0, 1.0])])
    assert bank.score("abc", ["other:1.0.0", "jailbreak:1.0.0"]) == pytest.approx(
        {
            "other:1.0.0": torch.sigmoid(torch.tensor(-2.0)).item(),
            "jailbreak:1.0.0": torch.sigmoid(torch.tensor(2.0)).item(),
        }
    )
    with pytest.raises(KeyError):
        bank.score("abc", ["jailbreak:2.0.0"])


@pytest.mark.parametrize(
    "change",
    [
        {"modelVersion": "other"},
        {"inputFormat": "other"},
        {"weights": [1.0]},
        {"weights": [1e100, 0.0]},
    ],
)
def test_reject_incompatible_artifacts(change):
    with pytest.raises(ValueError):
        ProbeBank(FakeEmbedder(), [artifact().model_copy(update=change)])


def test_training_pipeline_and_artifact_roundtrip(tmp_path):
    dataset = Path(__file__).parents[1] / "data/toy_jailbreak.csv"
    p = train(FakeEmbedder(), dataset, "jailbreak", "1.0.0")
    assert p.metrics.train_size == 30 and p.metrics.test_size == 10
    assert (
        sum(
            [
                p.metrics.true_negatives,
                p.metrics.false_positives,
                p.metrics.false_negatives,
                p.metrics.true_positives,
            ]
        )
        == 10
    )
    (tmp_path / "probe.json").write_text(p.model_dump_json())
    bank = ProbeBank(FakeEmbedder(), load_artifacts(tmp_path))
    assert 0 <= bank.score("hello", [p.key])[p.key] <= 1


def test_api_contract_and_errors():
    with TestClient(create_app(lambda: ProbeBank(FakeEmbedder(), [artifact()]))) as c:
        assert c.get("/health/ready").json()["probeIds"] == ["jailbreak:1.0.0"]
        data = {"text": "abc", "probeIds": ["jailbreak:1.0.0"]}
        res = c.post("/v1/score", json=data)
        assert res.status_code == 200 and set(res.json()) == {"scores", "modelVersion", "latencyMs"}
        for bad in [
            {**data, "prompt": "unexpected"},
            {**data, "probeIds": ["jailbreak:2.0.0"]},
            {**data, "probeIds": ["jailbreak:1.0.0"] * 2},
            {**data, "text": "x" * 8193},
            {**data, "probeIds": ["jailbreak"]},
        ]:
            assert c.post("/v1/score", json=bad).status_code == 422
        assert c.post("/v1/score", content=b"x" * 65537).status_code == 413


def test_busy_service_rejects_instead_of_queueing():
    entered, release = threading.Event(), threading.Event()

    class Slow(FakeEmbedder):
        def embed(self, text):
            entered.set()
            release.wait(5)
            return super().embed(text)

    with TestClient(create_app(lambda: ProbeBank(Slow(), [artifact()]))) as c:
        payload = {"text": "abc", "probeIds": ["jailbreak:1.0.0"]}
        results = []
        thread = threading.Thread(target=lambda: results.append(c.post("/v1/score", json=payload)))
        thread.start()
        try:
            assert entered.wait(2)
            assert c.post("/v1/score", json=payload).status_code == 503
        finally:
            release.set()
            thread.join(5)
        assert results[0].status_code == 200


def test_real_forward_hook_mean_pool_and_token_limit():
    class Block(torch.nn.Module):
        def forward(self, x):
            return (x + 1,)

    class Backbone(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.h = torch.nn.ModuleList([Block()])
            self.config = type("Config", (), {"hidden_size": 2})()

        def forward(self, input_ids, attention_mask, use_cache):
            return self.h[0](torch.stack([input_ids, input_ids * 2], dim=-1).float())

    def tokenizer(text, **_):
        return {
            "input_ids": torch.tensor([[1, 3, 10]]),
            "attention_mask": torch.tensor([[1, 1, 0]]),
        }

    embedder = HookedEmbedder(Backbone(), tokenizer, "fixture:v1", 0, 3)
    assert torch.allclose(embedder.embed("test"), torch.tensor([3.0, 5.0]))
    embedder.max_tokens = 2
    with pytest.raises(InputTooLong):
        embedder.embed("test")
    embedder.close()


def test_shared_wire_contract():
    import json
    from pydantic import ValidationError
    from inference_lab.contracts import ScoreRequest, ScoreResponse

    fixture = json.loads(
        (Path(__file__).parents[3] / "tests/fixtures/inference-contract.json").read_text()
    )
    for name, schema in [("requests", ScoreRequest), ("responses", ScoreResponse)]:
        for item in fixture[name]:
            if item["valid"]:
                schema.model_validate(item["value"])
            else:
                with pytest.raises(ValidationError):
                    schema.model_validate(item["value"])


def test_validation_does_not_echo_prompt():
    with TestClient(create_app(lambda: ProbeBank(FakeEmbedder(), [artifact()]))) as c:
        result = c.post("/v1/score", json={"text": "PRIVATE_TEXT", "probeIds": []})
        assert result.status_code == 422 and "PRIVATE_TEXT" not in result.text
