"""Server-only configuration for the hosted AI runtime.

The service token is held in a non-rendering field: configuration and errors must never
print it.  The Anthropic API key is deliberately not part of this object; only the provider
backend reads it from the process environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')
DEFAULT_MODELS = ('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5')
DEFAULT_MAX_UPLOAD_BYTES = 33554432
DEFAULT_MAX_CONCURRENCY = 2
DEFAULT_MAX_CALLS = 12
DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
DEFAULT_BIND = '127.0.0.1'
DEFAULT_PORT = 8787
PROVIDER = 'anthropic'

try:  # build identity is a plain first-party constant; keep the import optional for tests.
    from build_info import WORKBENCH_VERSION as _VERSION
except Exception:  # pragma: no cover - only when run outside the workbench source tree
    _VERSION = 'unknown'


class ConfigError(ValueError):
    """Fixed-code configuration failure; the message never contains a secret."""


def _env_int(env, name, default, low, high):
    raw = env.get(name)
    if raw is None or raw == '':
        return default
    try:
        value = int(raw, 10)
    except (TypeError, ValueError):
        raise ConfigError(f'{name} must be an integer') from None
    if not low <= value <= high:
        raise ConfigError(f'{name} is out of range')
    return value


def _env_list(env, name, default):
    raw = env.get(name)
    if raw is None or raw == '':
        return tuple(default)
    values = tuple(part.strip() for part in raw.split(',') if part.strip())
    if not values:
        raise ConfigError(f'{name} must list at least one value')
    return values


@dataclass(frozen=True)
class RuntimeConfig:
    """Validated runtime settings.  ``service_token`` is excluded from repr."""

    state_dir: Path
    service_token: str = field(repr=False)
    models: tuple = DEFAULT_MODELS
    default_model: str = DEFAULT_MODELS[0]
    efforts: tuple = EFFORTS
    default_effort: str = 'high'
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    max_calls: int = DEFAULT_MAX_CALLS
    job_retention_seconds: int = DEFAULT_RETENTION_SECONDS
    bind_host: str = DEFAULT_BIND
    bind_port: int = DEFAULT_PORT
    provider: str = PROVIDER
    version: str = _VERSION

    def __post_init__(self):
        state_dir = Path(self.state_dir).expanduser()
        if not isinstance(self.service_token, str) or not self.service_token:
            raise ConfigError('HOSTED_AI_SERVICE_TOKEN is required')
        if len(self.service_token) > 4096 or any(ch.isspace() for ch in self.service_token):
            raise ConfigError('HOSTED_AI_SERVICE_TOKEN must be a single token')
        models = tuple(self.models)
        if not models or any(not isinstance(m, str) or not m for m in models):
            raise ConfigError('HOSTED_AI_MODELS must list non-empty model ids')
        if len(set(models)) != len(models):
            raise ConfigError('HOSTED_AI_MODELS must not repeat a model')
        if self.default_model not in models:
            raise ConfigError('HOSTED_AI_DEFAULT_MODEL must be in HOSTED_AI_MODELS')
        efforts = tuple(self.efforts)
        if not efforts or any(e not in EFFORTS for e in efforts):
            raise ConfigError('efforts must be a subset of the allowlist')
        if self.default_effort not in efforts:
            raise ConfigError('the default effort must be in the effort allowlist')
        if isinstance(self.max_upload_bytes, bool) or not 1 <= int(self.max_upload_bytes) <= 1 << 30:
            raise ConfigError('HOSTED_AI_MAX_UPLOAD_BYTES must be 1..1073741824')
        if isinstance(self.max_concurrency, bool) or not 1 <= int(self.max_concurrency) <= 32:
            raise ConfigError('HOSTED_AI_MAX_CONCURRENCY must be 1..32')
        if isinstance(self.max_calls, bool) or not 1 <= int(self.max_calls) <= 512:
            raise ConfigError('HOSTED_AI_MAX_CALLS must be 1..512')
        if isinstance(self.job_retention_seconds, bool) or not 0 <= int(self.job_retention_seconds) <= 315360000:
            raise ConfigError('HOSTED_AI_JOB_RETENTION_SECONDS must be 0..315360000')
        if not isinstance(self.bind_host, str) or not self.bind_host:
            raise ConfigError('HOSTED_AI_BIND must be a host address')
        if isinstance(self.bind_port, bool) or not 0 <= int(self.bind_port) <= 65535:
            raise ConfigError('HOSTED_AI_PORT must be 0..65535')
        object.__setattr__(self, 'state_dir', state_dir)
        object.__setattr__(self, 'models', models)
        object.__setattr__(self, 'efforts', efforts)
        object.__setattr__(self, 'max_upload_bytes', int(self.max_upload_bytes))
        object.__setattr__(self, 'max_concurrency', int(self.max_concurrency))
        object.__setattr__(self, 'max_calls', int(self.max_calls))
        object.__setattr__(self, 'job_retention_seconds', int(self.job_retention_seconds))
        object.__setattr__(self, 'bind_port', int(self.bind_port))

    @classmethod
    def from_env(cls, env=None):
        values = os.environ if env is None else env
        state = values.get('HOSTED_AI_STATE_DIR')
        if not state:
            raise ConfigError('HOSTED_AI_STATE_DIR is required')
        token = values.get('HOSTED_AI_SERVICE_TOKEN')
        if not token:
            raise ConfigError('HOSTED_AI_SERVICE_TOKEN is required')
        models = _env_list(values, 'HOSTED_AI_MODELS', DEFAULT_MODELS)
        default_model = values.get('HOSTED_AI_DEFAULT_MODEL') or models[0]
        return cls(
            state_dir=Path(state),
            service_token=token,
            models=models,
            default_model=default_model,
            default_effort=values.get('HOSTED_AI_DEFAULT_EFFORT') or 'high',
            max_upload_bytes=_env_int(values, 'HOSTED_AI_MAX_UPLOAD_BYTES',
                                     DEFAULT_MAX_UPLOAD_BYTES, 1, 1 << 30),
            max_concurrency=_env_int(values, 'HOSTED_AI_MAX_CONCURRENCY',
                                     DEFAULT_MAX_CONCURRENCY, 1, 32),
            max_calls=_env_int(values, 'HOSTED_AI_MAX_CALLS', DEFAULT_MAX_CALLS, 1, 512),
            job_retention_seconds=_env_int(values, 'HOSTED_AI_JOB_RETENTION_SECONDS',
                                           DEFAULT_RETENTION_SECONDS, 0, 315360000),
            bind_host=values.get('HOSTED_AI_BIND') or DEFAULT_BIND,
            bind_port=_env_int(values, 'HOSTED_AI_PORT', DEFAULT_PORT, 0, 65535),
        )

    def public_health(self, ready):
        return {
            'ok': True,
            'provider': self.provider,
            'models': list(self.models),
            'version': self.version,
            'ready': bool(ready),
        }
