from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

Id = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$")]
Segment = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")]
ProbeKey = Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")]
Probability = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class ScoreRequest(StrictModel):
    text: Annotated[str, StringConstraints(min_length=1, max_length=8192)]
    probeIds: Annotated[list[ProbeKey], Field(min_length=1, max_length=32)]

    @field_validator("text")
    @classmethod
    def utf16_limit(cls, value: str) -> str:
        # Match JavaScript string.length (UTF-16 code units), not Python code points.
        if len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > 8192:
            raise ValueError("text too long")
        return value

    @field_validator("probeIds")
    @classmethod
    def unique(cls, ids: list[str]) -> list[str]:
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate probe IDs")
        return ids


class ScoreResponse(StrictModel):
    scores: Annotated[dict[ProbeKey, Probability], Field(min_length=1, max_length=32)]
    modelVersion: Id
    latencyMs: Annotated[float, Field(ge=0)]
