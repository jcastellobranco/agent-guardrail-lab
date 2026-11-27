# Inference service (Milestone 2)

Run commands from this directory using Python 3.11 or 3.12 (Linux CPU).

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
python -m pytest -q
python -m inference_lab.train
python -m uvicorn inference_lab.api:app --host 127.0.0.1 --port 8001 --workers 1
```

Training downloads the DistilGPT2 safetensors and tokenizer from the Hugging Face Hub on first run (hundreds of MB). Subsequent runs can use `HF_HUB_OFFLINE=1` once the snapshot is cached. The startup fails if model weights or compatible artifacts are absent; no dummy or randomly initialized production probe is silently substituted.

| Variable | Default | Meaning |
|---|---|---|
| MODEL_REVISION | 2290a62 | DistilGPT2 repository commit prefix; resolved to full SHA in artifacts |
| MODEL_LAYER | 3 | Zero-based fourth transformer block |
| MODEL_MAX_TOKENS | 256 | Reject overlong inputs, no silent truncation |
| TORCH_NUM_THREADS | 2 | CPU intra-op thread count |
| PROBE_DIR | artifacts | Trusted local JSON artifacts, loaded at startup and re-checked for changes |
| PROBE_RELOAD_INTERVAL_S | 5 | How often to check `PROBE_DIR` for new artifacts; a changed set is validated in full before it replaces the current one. `0` disables reloading |

Use the same model variables in training and serving. Training uses a stratified 75/25 split of 40 handwritten English examples. Labels: 1 = toy jailbreak attempt, 0 = benign. This tiny synthetic dataset and its holdout are **not** a credible security benchmark. The script reports held-out precision, recall, false-positive rate, confusion matrix, and sample counts at threshold 0.5. Runtime flag/block thresholds are configurable and must be calibrated against a separate representative dataset; the reported FPR does not automatically apply at other thresholds. The model is frozen throughout. Training creates `artifacts/jailbreak-1.0.0.json`; it refuses to overwrite an existing filename. For a new version, run `python -m inference_lab.train --version 1.0.1` and update the policy separately. Do not deploy same-version artifacts with different contents. Artifacts are local generated files, intentionally gitignored.

## Contract

```bash
curl -s http://127.0.0.1:8001/health/ready
curl -s http://127.0.0.1:8001/v1/score -H 'Content-Type: application/json' \
  -d '{"text":"{\"tool\":\"transfer_money\",\"arguments\":{\"amount\":500,\"note\":\"ordinary\"},\"context\":{\"prompt\":\"Please check the balance.\"}}","probeIds":["jailbreak:1.0.0"]}'
```

Returns `{scores: {"jailbreak:1.0.0": <number>}, modelVersion: <id>, latencyMs: <number>}`. Unknown versions or overlong input -> 422; overload -> 503. Text is limited to 8192 UTF-16 units, 256 model tokens by default, and 64 KiB HTTP request bytes. The training CSV's `text` is inserted into the same compact JSON envelope used by the runtime, with a fixed demo tool and arguments. Generalization to different tools, argument layouts, languages or adversarial prompts is untested. The model returns scores, not decisions. The inference endpoint is private, unauthenticated, and bound to loopback for this milestone; production needs network isolation/service identity and secure transport.

Shared contract fixtures in `../../tests/fixtures/inference-contract.json` are exercised by both Zod and Pydantic tests. Python models are maintained manually for now; automatic schema generation is deferred. No customer text is written to logs by the service; validation errors redact request values. Raw text still travels to the local inference service; never expose this endpoint publicly.

Opt-in real-model test (downloads weights if not cached): `RUN_REAL_MODEL_TEST=1 python -m pytest -q tests/test_real_model.py`. Default tests use fake embeddings and a real PyTorch forward hook on a tiny test backbone; they do not validate actual DistilGPT2 model quality.
