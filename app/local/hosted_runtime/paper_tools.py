"""Hosted paper-tools route. Reuses the companion handlers with one store per owner.

CPU calls (prepare, query, visual export, chart prepare) take a non-blocking
semaphore. Analysis jobs use a separate per-owner and global cap. Neither path
uses the RED/BLUE review executor. Paths, bodies, paper text and tokens are not logged.
"""

from __future__ import annotations

import re
import threading

from .service import OWNER_RE, ServiceError


def time_clock():
    import time
    return time.time()

PAPER_TTL = 7200
PAPER_KEEP = 2
IDLE_TTL = 7200
_KEYS = frozenset({'ownerId', 'path', 'body'})
_CODE = re.compile(r'[a-z][a-z0-9_]{0,79}\Z')
_JOB = re.compile(r'/api/paper/evidence/jobs/([a-f0-9]{32})(/cancel)?\Z')
_ROUTES = {
    '/api/paper/evidence/prepare': 'prepare',
    '/api/paper/evidence/query': 'query',
    '/api/paper/visual/export': 'visual',
    '/api/paper/chart/prepare': 'chart',
    '/api/paper/evidence/jobs': 'analysis',
}


def _envelope(payload):
    if not isinstance(payload, dict) or set(payload) != _KEYS:
        raise ServiceError('invalid_request', 400)
    owner, path, body = payload['ownerId'], payload['path'], payload['body']
    if not isinstance(owner, str) or not isinstance(path, str):
        raise ServiceError('invalid_request', 400)
    if OWNER_RE.fullmatch(owner) is None:
        raise ServiceError('invalid_request', 400)
    if body is not None and not isinstance(body, dict):
        raise ServiceError('invalid_request', 400)
    return owner, path, body


def _classify(path):
    kind = _ROUTES.get(path)
    if kind is not None:
        return kind, None
    match = _JOB.fullmatch(path)
    if match is None:
        raise ServiceError('paper_path_unsupported', 404)
    if match.group(2):
        return 'cancel', match.group(1)
    return 'poll', match.group(1)


def _safe_code(error):
    if not error.args:
        return 'invalid_request'
    code = error.args[0]
    if isinstance(code, str) and _CODE.fullmatch(code):
        return code
    return 'invalid_request'


def _from_value(kind, error):
    code = _safe_code(error)
    if code == 'companion_busy':
        return ServiceError('paper_busy', 429)
    if kind == 'poll':
        return ServiceError(code, 404)
    return ServiceError(code, 400)


def _job_status(receipt):
    if isinstance(receipt, dict) and receipt.get('state') == 'running':
        return 202, receipt
    return 200, receipt


def _chart_shape(body):
    if not isinstance(body, dict):
        return False
    ops = body.get('operations')
    if not isinstance(ops, list):
        return False
    for op in ops:
        if isinstance(op, dict) and op.get('kind') == 'chart-shape':
            return True
    return False


def _idle_owner(owners):
    for key, state in owners.items():
        if state.active_analysis == 0:
            return key
    return None


def _shutdown(state):
    try:
        state.jobs.shutdown()
    except Exception:
        return


def _shutdown_all(states):
    for state in states:
        _shutdown(state)


class _Owner:
    def __init__(self, store, charts, jobs, seen):
        self.store = store
        self.charts = charts
        self.jobs = jobs
        self.last_used = seen
        self.active_analysis = 0

    @classmethod
    def create(cls, clock):
        from paper_chart_edit_service import ChartEditService
        from paper_enrichment import AnalysisJobs
        from paper_evidence import EvidenceStore
        store = EvidenceStore(ttl_seconds=PAPER_TTL, max_documents=PAPER_KEEP, clock=clock)
        charts = ChartEditService(store=store, clock=clock)
        return cls(store, charts, AnalysisJobs(store=store), clock())


class PaperTools:
    """Per-owner paper state for ``POST /internal/v1/paper``."""

    def __init__(self, config, *, handlers=None, clock=None):
        self.enabled = bool(config.paper_tools)
        self.handlers = {} if handlers is None else dict(handlers)
        self._max_owners = config.paper_max_owners
        self._max_analysis = config.paper_max_analysis
        self._slots = threading.BoundedSemaphore(config.paper_max_concurrency)
        self._clock = time_clock if clock is None else clock
        self._lock = threading.RLock()
        self._scenes = threading.Lock()
        self._owners = {}
        self._analysis_active = 0
        self._closed = False

    def health(self):
        import paper_analysis_service
        import paper_chart_edit_service
        import paper_enrichment
        return {
            'enabled': True,
            'visualEditor': bool(paper_analysis_service.capability().get('available')),
            'chartEdit': bool(paper_chart_edit_service.capability().get('available')),
            'analysis': bool(paper_enrichment.capability().get('runtimeConfigured')),
        }

    def handle(self, payload):
        if not self.enabled:
            raise ServiceError('paper_tools_disabled', 404)
        owner, path, body = _envelope(payload)
        kind, arg = _classify(path)
        try:
            return self._run(owner, kind, arg, body)
        except ServiceError:
            raise
        except ValueError as error:
            raise _from_value(kind, error) from None
        except Exception:
            raise ServiceError('internal_error', 500) from None

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            owners = list(self._owners.values())
            self._owners.clear()
        _shutdown_all(owners)

    def _run(self, owner, kind, arg, body):
        if kind in ('poll', 'cancel', 'analysis'):
            return self._light(owner, kind, arg, body)
        return self._guarded(owner, kind, body)

    def _light(self, owner, kind, arg, body):
        state = self._owner_state(owner)
        if kind == 'analysis':
            return _job_status(self._submit(state, body))
        if kind == 'poll':
            return 200, state.jobs.get(arg)
        return _job_status(state.jobs.cancel(arg))

    def _submit(self, state, body):
        return state.jobs.submit(body, admit=lambda: self._admit(state),
                                 release=lambda: self._release(state))

    def _guarded(self, owner, kind, body):
        if not self._slots.acquire(blocking=False):
            raise ServiceError('paper_busy', 429)
        try:
            state = self._owner_state(owner)
            return 200, self._call(state, kind, body)
        finally:
            self._slots.release()

    def _call(self, state, kind, body):
        custom = self.handlers.get(kind)
        if custom is not None:
            return custom(state, body)
        if kind == 'prepare':
            from paper_evidence_http import prepare
            return prepare(body, store=state.store)
        if kind == 'query':
            from paper_evidence_http import query
            return query(body, store=state.store)
        if kind == 'visual':
            return self._visual(state, body)
        if kind == 'chart':
            return state.charts.prepare(body)
        raise ServiceError('paper_path_unsupported', 404)

    def _visual(self, state, body):
        from paper_visual_edit import export_visual
        if not _chart_shape(body):
            return export_visual(body, store=state.store)
        return self._visual_with_scenes(state, body, export_visual)

    def _visual_with_scenes(self, state, body, export_visual):
        # export_visual reads the module-global chart service for chart-shape plans.
        import paper_chart_edit_service as charts
        with self._scenes:
            previous = charts.default_service
            charts.default_service = state.charts
            try:
                return export_visual(body, store=state.store)
            finally:
                charts.default_service = previous

    def _owner_state(self, owner):
        dropped = []
        try:
            with self._lock:
                if self._closed:
                    raise ServiceError('ai_unavailable', 503)
                dropped.extend(self._pop_idle())
                state = self._owners.pop(owner, None)
                if state is None:
                    dropped.extend(self._pop_overflow())
                    state = _Owner.create(self._clock)
                state.last_used = self._clock()
                self._owners[owner] = state
                return state
        finally:
            _shutdown_all(dropped)

    def _pop_idle(self):
        now = self._clock()
        keys = []
        for key, state in self._owners.items():
            if state.active_analysis == 0 and now - state.last_used >= IDLE_TTL:
                keys.append(key)
        return [self._owners.pop(key) for key in keys]

    def _pop_overflow(self):
        dropped = []
        while len(self._owners) >= self._max_owners:
            victim = _idle_owner(self._owners)
            if victim is None:
                raise ServiceError('paper_busy', 429)
            dropped.append(self._owners.pop(victim))
        return dropped

    def _admit(self, state):
        with self._lock:
            if state.active_analysis >= 1 or self._analysis_active >= self._max_analysis:
                return False
            state.active_analysis += 1
            self._analysis_active += 1
            return True

    def _release(self, state):
        with self._lock:
            if state.active_analysis > 0:
                state.active_analysis -= 1
            if self._analysis_active > 0:
                self._analysis_active -= 1
            state.last_used = self._clock()
