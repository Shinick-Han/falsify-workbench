"""Execution profiles: per-batch provider capacity is separate from overall review coverage.

Local CLI runs keep their historical conservative bounds. Hosted Anthropic runs split the supplied text (and images)
into bounded batches, accumulate every valid item across batches, and report any batch not attempted because the
job's own call budget was reached. Nothing is silently truncated: a partial run says so and lists the remaining
coverage. Per-batch values are server-configurable so an operator can tune them to the provider/model capacity.
"""
import os
from types import MappingProxyType


def _env_int(name, default, low, high):
    raw = os.environ.get(name)
    if raw is None or raw == '':
        return default
    try:
        value = int(raw, 10)
    except (TypeError, ValueError):
        return default
    return value if low <= value <= high else default


LOCAL = MappingProxyType({
    'hosted': False,
    'red_chunk_chars': 36000,
    'red_max_candidates': 12,
    'red_notes_budget': 60000,
    'red_max_note': 6000,
    'max_calls': 32,
    'prompt_chars': 100000,
    'timeout_seconds': 180,
    'blue_max_findings': 12,
    'blue_max_prompt': 100000,
    'blue_max_context': 48000,
    'blue_max_targets': 8,
    'blue_index_budget': 30000,
    'blue_index_part': 6000,
    'max_images': 6,
    'source_chars': 1000000,
    'max_segments': 10000,
    # No batching outside hosted execution; the legacy single/multi-chunk path is unchanged.
    'red_batch_chars': 1000000,
    'blue_batch_chars': 1000000,
    'red_candidates_per_batch': 12,
    'blue_findings_per_batch': 12,
    'images_per_batch': 6,
    'provider_max_tokens': 16000,
    'image_capacity': 6,
})


def hosted_profile():
    """Read tunables at call time; each job snapshots the resulting profile through its request."""
    return MappingProxyType({
        'hosted': True,
        # Legacy hosted chunking is retained only for the paper-evidence fallback path.
        'red_chunk_chars': _env_int('HOSTED_AI_RED_CHUNK_CHARS', 120000, 20000, 1000000),
        'red_max_candidates': _env_int('HOSTED_AI_RED_MAX_CANDIDATES', 40, 1, 512),
        'red_notes_budget': _env_int('HOSTED_AI_RED_NOTES_BUDGET', 240000, 20000, 2000000),
        'red_max_note': _env_int('HOSTED_AI_RED_MAX_NOTE', 24000, 1000, 200000),
        'max_calls': _env_int('HOSTED_AI_MAX_CALLS', 512, 1, 512),
        'prompt_chars': _env_int('HOSTED_AI_PROMPT_CHARS', 400000, 20000, 2000000),
        'timeout_seconds': _env_int('HOSTED_AI_TIMEOUT_SECONDS', 600, 1, 3600),
        'blue_max_findings': _env_int('HOSTED_AI_BLUE_MAX_FINDINGS', 40, 1, 512),
        'blue_max_prompt': _env_int('HOSTED_AI_PROMPT_CHARS', 400000, 20000, 2000000),
        'blue_max_context': _env_int('HOSTED_AI_CONTEXT_CHARS', 240000, 20000, 2000000),
        'blue_max_targets': _env_int('HOSTED_AI_REREAD_TARGETS', 24, 1, 64),
        'blue_index_budget': _env_int('HOSTED_AI_INDEX_BUDGET', 120000, 1000, 2000000),
        'blue_index_part': _env_int('HOSTED_AI_INDEX_PART', 24000, 1000, 200000),
        'max_images': _env_int('HOSTED_AI_MAX_IMAGES', 64, 1, 100),
        'source_chars': _env_int('HOSTED_AI_SOURCE_CHARS', 4000000, 100000, 20000000),
        'max_segments': _env_int('HOSTED_AI_MAX_SEGMENTS', 50000, 1, 200000),
        'red_batch_chars': _env_int('HOSTED_AI_RED_BATCH_CHARS', 100000, 10000, 1000000),
        'blue_batch_chars': _env_int('HOSTED_AI_BLUE_BATCH_CHARS', 100000, 10000, 1000000),
        'red_candidates_per_batch': _env_int('HOSTED_AI_RED_CANDIDATES_PER_BATCH', 40, 1, 256),
        'blue_findings_per_batch': _env_int('HOSTED_AI_BLUE_FINDINGS_PER_BATCH', 40, 1, 256),
        'images_per_batch': _env_int('HOSTED_AI_IMAGES_PER_BATCH', 8, 1, 32),
        'provider_max_tokens': _env_int('HOSTED_AI_MAX_OUTPUT_TOKENS', 32000, 256, 128000),
        'image_capacity': _env_int('HOSTED_AI_IMAGE_CAPACITY', 64, 1, 100),
    })


HOSTED = hosted_profile()


def for_data(data):
    """Hosted only for the server-side hosted adapter; client-supplied settings cannot widen local runs."""
    harness = data.get('harness') if isinstance(data, dict) else None
    adapter = harness.get('adapter') if isinstance(harness, dict) else None
    return hosted_profile() if isinstance(adapter, dict) and adapter.get('type') == 'hosted' else LOCAL
