"""Opt-in smoke test; never downloads model weights in the default unit suite."""

import os
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from inference_lab.api import create_app
from inference_lab.model import load_embedder
from inference_lab.probes import ProbeBank
from inference_lab.train import train, tool_text


@pytest.mark.skipif(os.getenv("RUN_REAL_MODEL_TEST") != "1", reason="requires Hugging Face weights")
def test_real_model_training_and_scoring():
    model = load_embedder()
    dataset = Path(__file__).parents[1] / "data/toy_jailbreak.csv"
    try:
        artifact = train(model, dataset, "jailbreak", "smoke")
        bank = ProbeBank(model, [artifact])
        with TestClient(create_app(lambda: bank)) as client:
            result = client.post(
                "/v1/score",
                json={"text": tool_text("Please check the balance."), "probeIds": [artifact.key]},
            )
            assert result.status_code == 200
            assert 0 <= result.json()["scores"][artifact.key] <= 1
    finally:
        model.close()
