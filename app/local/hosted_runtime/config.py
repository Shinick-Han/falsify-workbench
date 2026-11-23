"""Server-only configuration for the hosted AI runtime.

The service token is held in a non-rendering field: configuration and errors must never
print it.  Provider API keys are deliberately not part of this object; only the provider
backend reads them from the process environment.
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
DEFAULT_MAX_PROMPT_CHARS = 32000
DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
DEFAULT_BIND = '127.0.0.1'
DEFAULT_PORT = 8787

try:  # build identity is a plain first-party constant; keep the import optional for tests.
    from build_info import WORKBENCH_VERSION as _VERSION
except Exception:  # pragma: no cover - only when run outside the workbench source tree
    _VERSION = 'unknown'


class ConfigError(ValueError):
    """Fixed-code configuration failure; the message never contains a secret."""


def provider_for_model(model):
    """Identify the provider for a supported model family."""
    if not isinstance(model, str) or not model:
        return None
    if model == 'gemini-4-neon-high':
        return 'agy-cli'
    if model.startswith('claude-'):
        return 'anthropic'
    if model.startswith('gpt-') or (len(model) > 1 and model[0] == 'o' and model[1].isdigit()):
        return 'openai'
    return None


def _allowlist_providers(models):
    found = {provider_for_model(model) for model in models}
    found.discard(None)
    return sorted(found)


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


def _env_flag(env, name):
    raw = env.get(name)
    if raw in (None, '', '0'):
        return False
    if raw != '1':
        raise ConfigError(f'{name} must be 0 or 1')
    return True


def _paper_limit(name, value, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ConfigError(f'{name} is out of range')
    return value


def _check_paper(enabled, max_owners, max_concurrency, max_analysis):
    if not isinstance(enabled, bool):
        raise ConfigError('HOSTED_PAPER_TOOLS must be boolean')
    return (
        enabled,
        _paper_limit('HOSTED_PAPER_MAX_OWNERS', max_owners, 1, 1024),
        _paper_limit('HOSTED_PAPER_MAX_CONCURRENCY', max_concurrency, 1, 32),
        _paper_limit('HOSTED_PAPER_MAX_ANALYSIS', max_analysis, 1, 32),
    )


def _env_list(env, name, default):
    raw = env.get(name)
    if raw is None or raw == '':
        return tuple(default)
    values = tuple(part.strip() for part in raw.split(',') if part.strip())
    if not values:
        raise ConfigError(f'{name} must list at least one value')
    return values


def _check_token(token):
    if not isinstance(token, str) or not token:
        raise ConfigError('HOSTED_AI_SERVICE_TOKEN is required')
    if len(token) > 4096 or any(ch.isspace() for ch in token):
        raise ConfigError('HOSTED_AI_SERVICE_TOKEN must be a single token')


def _check_models(models, default_model):
    models = tuple(models)
    if not models or any(not isinstance(m, str) or not m for m in models):
        raise ConfigError('HOSTED_AI_MODELS must list non-empty model ids')
    if len(set(models)) != len(models):
        raise ConfigError('HOSTED_AI_MODELS must not repeat a model')
    if default_model not in models:
        raise ConfigError('HOSTED_AI_DEFAULT_MODEL must be in HOSTED_AI_MODELS')
    if any(provider_for_model(model) is None for model in models):
        raise ConfigError('HOSTED_AI_MODELS contains a model with no provider')
    return models


def _check_efforts(efforts, default_effort):
    efforts = tuple(efforts)
    if not efforts or any(e not in EFFORTS for e in efforts):
        raise ConfigError('efforts must be a subset of the allowlist')
    if default_effort not in efforts:
        raise ConfigError('the default effort must be in the effort allowlist')
    return efforts


def _check_limits(max_upload_bytes, max_concurrency, max_calls, max_prompt_chars,
                  job_retention_seconds):
    if isinstance(max_upload_bytes, bool) or not 1 <= int(max_upload_bytes) <= 1 << 30:
        raise ConfigError('HOSTED_AI_MAX_UPLOAD_BYTES must be 1..1073741824')
    if isinstance(max_concurrency, bool) or not 1 <= int(max_concurrency) <= 32:
        raise ConfigError('HOSTED_AI_MAX_CONCURRENCY must be 1..32')
    if isinstance(max_calls, bool) or not 1 <= int(max_calls) <= 512:
        raise ConfigError('HOSTED_AI_MAX_CALLS must be 1..512')
    if isinstance(max_prompt_chars, bool) or not 1000 <= int(max_prompt_chars) <= 200000:
        raise ConfigError('HOSTED_AI_MAX_PROMPT_CHARS must be 1000..200000')
    if isinstance(job_retention_seconds, bool) or not 0 <= int(job_retention_seconds) <= 315360000:
        raise ConfigError('HOSTED_AI_JOB_RETENTION_SECONDS must be 0..315360000')
    return (int(max_upload_bytes), int(max_concurrency), int(max_calls),
            int(max_prompt_chars), int(job_retention_seconds))


def _check_bind(bind_host, bind_port):
    if not isinstance(bind_host, str) or not bind_host:
        raise ConfigError('HOSTED_AI_BIND must be a host address')
    if isinstance(bind_port, bool) or not 0 <= int(bind_port) <= 65535:
        raise ConfigError('HOSTED_AI_PORT must be 0..65535')
    return int(bind_port)


def _check_agy_socket(value):
    if value is None or value == '':
        return None
    if isinstance(value, Path):
        raw = str(value)
    elif isinstance(value, str):
        raw = value.strip()
    else:
        raise ConfigError('HOSTED_AI_AGY_SOCKET must be an absolute Unix socket path')
    if not raw:
        return None
    if any(ord(ch) < 32 for ch in raw) or not Path(raw).is_absolute():
        raise ConfigError('HOSTED_AI_AGY_SOCKET must be an absolute Unix socket path')
    if len(raw.encode('utf-8')) > 107:
        raise ConfigError('HOSTED_AI_AGY_SOCKET path is too long')
    return raw


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
    max_prompt_chars: int = DEFAULT_MAX_PROMPT_CHARS
    job_retention_seconds: int = DEFAULT_RETENTION_SECONDS
    bind_host: str = DEFAULT_BIND
    bind_port: int = DEFAULT_PORT
    provider: str = 'anthropic'
    version: str = _VERSION
    paper_tools: bool = False
    paper_max_owners: int = 32
    paper_max_concurrency: int = 2
    paper_max_analysis: int = 1
    agy_socket: str | None = None
    blue_default_model: str | None = None

    def __post_init__(self):
        state_dir = Path(self.state_dir).expanduser()
        _check_token(self.service_token)
        models = _check_models(self.models, self.default_model)
        if self.blue_default_model is not None and self.blue_default_model not in models:
            raise ConfigError('HOSTED_AI_BLUE_DEFAULT_MODEL must be in HOSTED_AI_MODELS')
        efforts = _check_efforts(self.efforts, self.default_effort)
        max_upload, max_concurrency, max_calls, max_prompt, retention = _check_limits(
            self.max_upload_bytes, self.max_concurrency, self.max_calls,
            self.max_prompt_chars, self.job_retention_seconds)
        bind_port = _check_bind(self.bind_host, self.bind_port)
        enabled, owners, paper_concurrency, paper_analysis = _check_paper(
            self.paper_tools, self.paper_max_owners, self.paper_max_concurrency,
            self.paper_max_analysis)
        agy_socket = _check_agy_socket(self.agy_socket)
        object.__setattr__(self, 'state_dir', state_dir)
        object.__setattr__(self, 'models', models)
        object.__setattr__(self, 'provider', provider_for_model(models[0]))
        object.__setattr__(self, 'efforts', efforts)
        object.__setattr__(self, 'max_upload_bytes', max_upload)
        object.__setattr__(self, 'max_concurrency', max_concurrency)
        object.__setattr__(self, 'max_calls', max_calls)
        object.__setattr__(self, 'max_prompt_chars', max_prompt)
        object.__setattr__(self, 'job_retention_seconds', retention)
        object.__setattr__(self, 'bind_port', bind_port)
        object.__setattr__(self, 'paper_tools', enabled)
        object.__setattr__(self, 'paper_max_owners', owners)
        object.__setattr__(self, 'paper_max_concurrency', paper_concurrency)
        object.__setattr__(self, 'paper_max_analysis', paper_analysis)
        object.__setattr__(self, 'agy_socket', agy_socket)

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
            max_prompt_chars=_env_int(values, 'HOSTED_AI_MAX_PROMPT_CHARS',
                                      DEFAULT_MAX_PROMPT_CHARS, 1000, 200000),
            job_retention_seconds=_env_int(values, 'HOSTED_AI_JOB_RETENTION_SECONDS',
                                           DEFAULT_RETENTION_SECONDS, 0, 315360000),
            bind_host=values.get('HOSTED_AI_BIND') or DEFAULT_BIND,
            bind_port=_env_int(values, 'HOSTED_AI_PORT', DEFAULT_PORT, 0, 65535),
            paper_tools=_env_flag(values, 'HOSTED_PAPER_TOOLS'),
            paper_max_owners=_env_int(values, 'HOSTED_PAPER_MAX_OWNERS', 32, 1, 1024),
            paper_max_concurrency=_env_int(values, 'HOSTED_PAPER_MAX_CONCURRENCY', 2, 1, 32),
            paper_max_analysis=_env_int(values, 'HOSTED_PAPER_MAX_ANALYSIS', 1, 1, 32),
            agy_socket=values.get('HOSTED_AI_AGY_SOCKET') or None,
            blue_default_model=values.get('HOSTED_AI_BLUE_DEFAULT_MODEL') or None,
        )

    def public_health(self, ready):
        return {
            'ok': True,
            'provider': self.provider,
            'providers': _allowlist_providers(self.models),
            'models': list(self.models),
            'version': self.version,
            'ready': bool(ready),
        }
