"""Configuration for the BugDNA risk service.

Every environment variable this service reads is declared here once and
validated at import time, so a misconfiguration fails at startup with a clear
message rather than surfacing as a confusing runtime error.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime settings, populated from the environment."""

    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        # `model_` is a Pydantic-reserved prefix; MODEL_DIR etc. are ours.
        protected_namespaces=(),
    )

    # --- service ---
    environment: str = Field(default="development", alias="NODE_ENV")
    ml_port: int = Field(default=8000, alias="ML_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    log_format: str = Field(default="json", alias="LOG_FORMAT")

    # --- auth ---
    # Shared secret for backend -> ML calls. The service is internal-only and is
    # never exposed through the reverse proxy; this is defence in depth for the
    # case where it is.
    service_token: str = Field(default="", alias="ML_SERVICE_TOKEN")

    # --- model ---
    model_dir: Path = Field(default=Path("/app/models"), alias="MODEL_DIR")
    model_name: str = Field(default="bugdna-risk", alias="MODEL_NAME")
    # A specific version, or `latest` to resolve the newest artifact on disk.
    model_version: str = Field(default="latest", alias="MODEL_VERSION")

    # When no usable artifact exists, serve the transparent heuristic scorer
    # instead of failing. Always labelled as such in the response, so a fallback
    # score is never mistaken for a model score.
    allow_heuristic_fallback: bool = Field(
        default=True, alias="ALLOW_HEURISTIC_FALLBACK"
    )

    shap_max_features_returned: int = Field(
        default=12, ge=1, le=100, alias="SHAP_MAX_FEATURES_RETURNED"
    )

    # --- feature contract ---
    # Directory holding feature-spec.json, generated from the TypeScript feature
    # registry. See backend/scripts/generate-feature-contract.ts.
    contracts_dir: Path = Field(default=Path("/app/contracts"), alias="CONTRACTS_DIR")

    @field_validator("log_level")
    @classmethod
    def _normalise_log_level(cls, value: str) -> str:
        level = value.upper()
        # The Node services use lowercase pino levels; map the ones that differ.
        aliases = {"WARN": "WARNING", "FATAL": "CRITICAL", "TRACE": "DEBUG", "SILENT": "CRITICAL"}
        level = aliases.get(level, level)
        if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            return "INFO"
        return level

    @field_validator("model_dir", "contracts_dir")
    @classmethod
    def _resolve_path(cls, value: Path) -> Path:
        return value.expanduser()

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def candidate_contract_paths(self) -> list[Path]:
        """Where to look for the feature contract, in priority order.

        The configured directory wins. The fallbacks make the service runnable
        straight from a checkout (`uvicorn app.main:app`) without setting
        CONTRACTS_DIR, which matters for local development and tests.
        """
        here = Path(__file__).resolve()
        repo_root = here.parents[2]  # ml-service/app/config.py -> repo root
        return [
            self.contracts_dir / "feature-spec.json",
            repo_root / "contracts" / "feature-spec.json",
            here.parents[1] / "contracts" / "feature-spec.json",
        ]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
