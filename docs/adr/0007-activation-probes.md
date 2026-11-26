# ADR 0007: One frozen transformer and versioned linear probes

Status: accepted for milestone 2.

Use DistilGPT2 (Hugging Face `distilbert/distilgpt2`, Apache-2.0), a compact causal language model, with a hook on transformer block 3 (zero-based). Use the backbone without vocabulary logits or generation. Mean pool token activations. Train a logistic regression classifier with normalization fit only on the training split, then fold normalization into weights and bias. Score all loaded probes in one matrix-vector product and return only requested versions.

Alternatives: deterministic rules are cheaper and explainable but lack semantic coverage; an LLM judge adds generation latency and variability; a separately trained classifier might be more accurate for specific tasks but does not demonstrate activation probes. No detection-quality claim is made for this toy dataset. Model revision, layer, token limit and input format are part of model identity; probe artifacts cannot be loaded across incompatible configurations. JSON artifacts avoid pickle deserialization, but must still be trusted local files; signed distribution arrives in milestone 3.

Reference: https://huggingface.co/distilbert/distilgpt2
