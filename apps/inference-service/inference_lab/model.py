"""A single forward hook; no autoregressive generation or vocabulary logits."""
import os
from pathlib import Path
from typing import Protocol
import torch

MODEL_ID = "distilbert/distilgpt2"
INPUT_FORMAT = "tool-json-v1"


class InputTooLong(ValueError):
    pass


class Embedder(Protocol):
    model_version: str
    dimension: int
    def embed(self, text: str) -> torch.Tensor: ...


class HookedEmbedder:
    def __init__(self, backbone, tokenizer, model_version: str, layer: int, max_tokens: int):
        if not 0 <= layer < len(backbone.h) or not 1 <= max_tokens <= 1024:
            raise ValueError("invalid layer or token limit")
        self.backbone = backbone.eval()
        self.tokenizer = tokenizer
        self.model_version = model_version
        self.dimension = backbone.config.hidden_size
        self.max_tokens = max_tokens
        self._activation = None
        self._hook = backbone.h[layer].register_forward_hook(self._capture)

    def _capture(self, _module, _inputs, output):
        self._activation = output[0] if isinstance(output, tuple) else output

    @torch.inference_mode()
    def embed(self, text: str) -> torch.Tensor:
        encoded = self.tokenizer(text, return_tensors="pt", truncation=False,
                                 add_special_tokens=False, verbose=False)
        if encoded["input_ids"].shape[1] not in range(1, self.max_tokens + 1):
            raise InputTooLong("input exceeds token limit or is empty")
        self._activation = None
        try:
            self.backbone(**encoded, use_cache=False)
            if self._activation is None:
                raise RuntimeError("forward hook did not capture activations")
            mask = encoded["attention_mask"].unsqueeze(-1)
            pooled = (self._activation * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
            return pooled[0].float().clone()
        finally:
            self._activation = None

    def close(self):
        self._hook.remove()


def load_embedder() -> HookedEmbedder:
    # Lazy imports let offline tests exercise the real hook and probe math without downloading weights.
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForCausalLM, AutoTokenizer
    revision = os.getenv("MODEL_REVISION", "2290a62")
    layer = int(os.getenv("MODEL_LAYER", "3"))  # zero-based fourth transformer block
    max_tokens = int(os.getenv("MODEL_MAX_TOKENS", "256"))
    torch.set_num_threads(int(os.getenv("TORCH_NUM_THREADS", "2")))
    snapshot = snapshot_download(MODEL_ID, revision=revision,
        allow_patterns=["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "special_tokens_map.json", "generation_config.json"],
        local_files_only=os.getenv("HF_HUB_OFFLINE") == "1")
    commit = Path(snapshot).name
    tokenizer = AutoTokenizer.from_pretrained(snapshot, local_files_only=True, trust_remote_code=False)
    lm = AutoModelForCausalLM.from_pretrained(snapshot, local_files_only=True,
        trust_remote_code=False, use_safetensors=True).to("cpu").eval()
    return HookedEmbedder(lm.transformer, tokenizer,
        f"distilgpt2:{commit}:l{layer}:t{max_tokens}:tool-json-v1", layer, max_tokens)
