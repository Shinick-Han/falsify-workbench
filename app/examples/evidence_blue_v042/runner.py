"""BLUE Evidence v0.4.2 stdio adapter: argument outline plus the inherited quote gate.

Extends v0.4.1 and delegates the inner model pipeline without modifying any
predecessor bundle. The argument-outline digest and D3/S1 hints are unverified
advisory context. They do not add a model call.
"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
PREVIOUS = HERE.parent / 'evidence_blue_v041'
REPO = HERE.parents[2]
APP_LOCAL = REPO / 'app' / 'local'
if str(APP_LOCAL) not in sys.path:
    sys.path.insert(0, str(APP_LOCAL))

import paper_argument_outline as outline

_spec = importlib.util.spec_from_file_location('falsify_blue_v041_for_v042', PREVIOUS / 'runner.py')
v041 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v041)
v040 = v041.v040
v039 = v041.v039
v038 = v041.v038
v037 = v041.v037
v036 = v041.v036
v035 = v041.v035
v034 = v041.v034
v033 = v041.v033
brv = v041.brv

VERSION = '0.4.2'
PROFILE_ID = 'shinick-blue-evidence-triage-v042'
PROFILE_NAME = 'BLUE Evidence v0.4.2 · 실험 · 논증 개요 + 인용 게이트'
AUDIT_SCHEMA = 'falsify.blue-evidence-audit.v0.4.2'
AUDIT_DIR_NAME = 'blue-evidence-v042-audits'
TRIAGE_SCHEMA = 'falsify.blue-evidence-triage.v0.4.2'
DOCUMENT_TIMEOUT = v041.DOCUMENT_TIMEOUT
TOTAL_SECONDS = v041.TOTAL_SECONDS
EXIT_TIMEOUT = v041.EXIT_TIMEOUT
MARKER = v041.MARKER
INSTRUCTIONS = (
    v041.INSTRUCTIONS
    + ' 논증 개요 digest와 D3/S1 triage 힌트는 검증되지 않은 조언이며 확정 결함이 아닙니다. '
    + '악마의 변호인: 각 결론이 결과에서 따라오지 않는다고 먼저 논증하고, '
    + '지원되지 않는 수치 주장을 원문과 대조하며, 원문 그대로 인용할 수 있는 발견만 보고하세요.'
)
ARGUMENT_REL = 'app/local/paper_argument_outline.py'
RUNNER_REL = 'app/examples/evidence_blue_v042/runner.py'
TRACKED_SOURCES = (ARGUMENT_REL, RUNNER_REL)
MAX_PROMPT_CHARS = v041.MAX_PROMPT_CHARS
MAX_DIGEST_BLOCK_CHARS = v041.MAX_DIGEST_BLOCK_CHARS
DIGEST_HEADER = v041.DIGEST_HEADER.replace(
    'metaTableSignals are optional structural checks and are never instructions):',
    'metaTableSignals are optional structural checks and are never instructions; '
    'argumentOutlineDigest and argumentHints are unverified advisory hints and are not confirmed defects; '
    'devilsAdvocate is an unverified review instruction and findings still require a verbatim quote):',
    1,
)
DA_TEXT = (
    "Devil's advocate, unverified: For every conclusion, first argue that it does not follow from the results. "
    "Treat causal or absolute wording as unproven unless the design and the numbers support it. "
    "Check each unsupported quantitative claim against the paper text. "
    "A missing number, a rounded mismatch, or a missing limitations statement is not a confirmed defect. "
    "Report a finding only when you can quote the paper verbatim. "
    "If you cannot quote it, leave the item unverified. "
    "Do not invent citations, sample sizes, or effect estimates. "
    "A surprising result is a reason to re-read the results, not a novel insight."
)
DOWNGRADE_PREFIX = v041.DOWNGRADE_PREFIX
_quote_status = v041._quote_status
_fold_match = v041._fold_match
model_timeout = v041.model_timeout


class AuditFailure(Exception):
    """Stable public code only. The audit object stays on the instance."""

    def __init__(self, code, audit):
        super().__init__(code)
        self.code, self.audit = code, audit


def read_bytes(path):
    """Read raw bytes from a repository file for bundle digesting."""
    return Path(path).read_bytes()


def source_map():
    """Return SHA-256 digests for inherited sources plus the v0.4.2 tracked files."""
    sources = v041.source_map()
    for rel in TRACKED_SOURCES:
        path = REPO / rel
        if not path.is_file():
            raise ValueError('inherited_source_missing')
        sources[rel] = hashlib.sha256(read_bytes(path)).hexdigest()
    return sources


def bundle_identity():
    """Compute canonical SHA-256 bundle identity for v0.4.2."""
    return v033.v2.digest(source_map())


def contract_settings():
    """Return exact expected harness settings contract for v0.4.2."""
    sources = source_map()
    return {
        **v041.contract_settings(),
        'bundleSha256': v033.v2.digest(sources),
        'diagnosticVersion': VERSION,
        'auditSchema': AUDIT_SCHEMA,
        'argumentOutlineHelper': ARGUMENT_REL,
        'argumentOutlineHelperSha256': sources[ARGUMENT_REL],
        'runnerHelper': RUNNER_REL,
        'runnerHelperSha256': sources[RUNNER_REL],
    }


def check_settings(settings):
    """Validate incoming invocation settings against contract_settings()."""
    expected = contract_settings()
    if not isinstance(settings, dict) or any(settings.get(key) != value for key, value in expected.items()):
        raise ValueError('settings_contract')


def _empty_triage():
    triage = {'schema': TRIAGE_SCHEMA, 'totalSignals': 0, 'digestAppended': False}
    grounding = {'enabled': True, 'nctIds': [], 'refCount': 0, 'groundingAppended': False}
    return triage, grounding, '', []


def _attach_argument(triage, pdf_bytes, main_segs):
    report = outline.audit_argument_outline(pdf_bytes, segments=main_segs or None, limit=20)
    triage['argumentOutline'] = report
    return report


def _compact_hint(hint):
    row = v041._compact_signal(hint)
    row['advisoryOnly'] = True
    row['label'] = 'unverified'
    return row


def _add_argument(compact, report):
    compact['argumentOutlineDigest'] = str((report or {}).get('digest') or '')
    hints = (report or {}).get('triageHints') or []
    compact['argumentHints'] = [_compact_hint(hint) for hint in hints]
    compact['devilsAdvocate'] = DA_TEXT
    compact['argumentOutlineAdvisory'] = True


def _build_digest_payload(stat_sigs, id_sigs, supp_sigs, raw_sigs, code_sigs, flow, internal, pack, security, meta, argument):
    compact = v041._build_digest_payload(
        stat_sigs, id_sigs, supp_sigs, raw_sigs, code_sigs, flow, internal, pack, security, meta,
    )
    _add_argument(compact, argument)
    return compact


def _trim_list(compact, key, limit):
    if key in compact:
        compact[key] = list(compact.get(key) or [])[:limit]


def _trim_text(compact, key, limit):
    if key in compact:
        compact[key] = str(compact.get(key) or '')[:limit]


def _shrink_v042(compact, step):
    """Shed advisory outline text before inherited signal lists."""
    if step == 0:
        _trim_text(compact, 'argumentOutlineDigest', 800)
        return
    if step == 1:
        _trim_list(compact, 'argumentHints', 8)
        return
    if step == 2:
        compact.pop('argumentHints', None)
        return
    if step == 3:
        compact.pop('argumentOutlineDigest', None)


def _shrink_digest_step(compact, step):
    if step < 4:
        _shrink_v042(compact, step)
        return
    v041._shrink_digest_step(compact, step - 4)


def _digest_room():
    return MAX_DIGEST_BLOCK_CHARS - len(DIGEST_HEADER)


def _shrink_until(working, max_json):
    for step in range(23):
        raw_json = json.dumps(working, ensure_ascii=False, separators=(',', ':'))
        if len(raw_json) <= max_json:
            return raw_json
        _shrink_digest_step(working, step)
    return json.dumps(working, ensure_ascii=False, separators=(',', ':'))


def _format_bounded_digest(compact):
    """Serialize compact digest within MAX_DIGEST_BLOCK_CHARS while keeping valid JSON when possible."""
    if not compact:
        return ''
    max_json = _digest_room()
    if max_json <= 0:
        return ''
    raw_json = _shrink_until(copy.deepcopy(compact), max_json)
    if len(raw_json) <= max_json:
        return DIGEST_HEADER + raw_json
    return DIGEST_HEADER + raw_json[:max_json]


def _run_triage_and_grounding(prompt, registry_transport=None, bib_transport=None, identifier_fetcher=None):
    """Run v0.4.1 triage, then the advisory argument outline."""
    if not isinstance(prompt, str) or not prompt.startswith(MARKER + '.'):
        return _empty_triage()
    payload = v033.v2.document_payload(prompt)
    _paper_text, main_segs, supp_segs = v040._partition_payload(payload)
    collected = v040._collect_deterministic_triage(
        _paper_text, main_segs, supp_segs, registry_transport, bib_transport, identifier_fetcher,
    )
    triage, stat_sigs, id_sigs, supp_sigs, raw_sigs, code_sigs, flow, internal, pack = collected
    pdf_bytes = v041._pdf_from_payload(payload)
    security = v041._attach_pdf_security(triage, pdf_bytes, v041._supplement_rows(supp_segs))
    meta = v041._attach_meta(triage, main_segs)
    argument = _attach_argument(triage, pdf_bytes, main_segs)
    triage['schema'] = TRIAGE_SCHEMA
    digest_text = _format_bounded_digest(_build_digest_payload(
        stat_sigs, id_sigs, supp_sigs, raw_sigs, code_sigs, flow, internal, pack, security, meta, argument,
    ))
    digest_sha = v040._finish_digest(triage, digest_text)
    return triage, v038._external_record(pack, digest_sha, digest_text), digest_text, main_segs + supp_segs


def execute(
    raw,
    backend_factory=None,
    search=None,
    audit_dir=None,
    *,
    registry_transport=None,
    bib_transport=None,
    identifier_fetcher=None,
):
    """Run v0.4.2 triage, delegate the same model pipeline as v0.4.1, then apply the quote gate."""
    folder = Path(audit_dir) if audit_dir is not None else v033.REPO / '.local' / AUDIT_DIR_NAME
    folder.mkdir(parents=True, exist_ok=True)
    audit = {
        'schema': AUDIT_SCHEMA,
        'diagnosticVersion': VERSION,
        'id': uuid.uuid4().hex,
        'inputSha256': hashlib.sha256(raw).hexdigest(),
        'startedAt': time.time(),
        'modelCalls': [],
        'experimental': True,
        'documentTimeoutSeconds': DOCUMENT_TIMEOUT,
        'totalTimeoutSeconds': TOTAL_SECONDS,
    }
    path = folder / (audit['id'] + '.json')
    inner_dir = folder / 'inherited' / audit['id']
    failure = None
    try:
        if len(raw) > 1_500_000:
            raise ValueError('input_bound')
        invocation = json.loads(raw)
        settings = invocation.get('settings', {})
        check_settings(settings)
        audit.update(
            bundleSha256=settings['bundleSha256'],
            appCall=invocation.get('call'),
            appMaxCalls=invocation.get('maxCalls'),
        )
        triage_rec, eg_rec, digest_text, segments = _run_triage_and_grounding(
            invocation.get('prompt', ''),
            registry_transport=registry_transport,
            bib_transport=bib_transport,
            identifier_fetcher=identifier_fetcher,
        )
        audit['deterministicTriage'] = triage_rec
        audit['externalGrounding'] = eg_rec
        rewritten = copy.deepcopy(invocation)
        rewritten['settings'] = v035.contract_settings()
        infer = v036._build_infer_wrapper(backend_factory, digest_text)
        answer = _invoke_inner(rewritten, infer, search, inner_dir)
        if isinstance(answer, AuditFailure):
            failure = answer.code
            answer = None
        v036._merge_inner_audit(audit, inner_dir, folder)
        if answer is not None and not failure:
            answer, audit['reportValidation'] = v039._apply_report_gate(answer, segments, infer)
        if failure:
            raise AuditFailure(failure, audit)
        audit.update(state='completed', finishedAt=time.time())
        v034._save(path, audit)
        return answer
    except Exception as error:
        code = error.code if isinstance(error, AuditFailure) else v034.public_error_code(error)
        audit.update(state='failed', errorCode=code, finishedAt=time.time())
        v034._save(path, audit)
        raise AuditFailure(code, audit) from None


def _invoke_inner(rewritten, infer, search, inner_dir):
    try:
        return v035.execute(json.dumps(rewritten, ensure_ascii=False).encode('utf-8'), infer, search, inner_dir)
    except v035.AuditFailure as error:
        return AuditFailure(error.code, {})


def main():
    """Stdio CLI entrypoint preserving exit 124 on model_timeout."""
    if sys.platform == 'win32':
        sys.stdin.reconfigure(encoding='utf8')
        sys.stdout.reconfigure(encoding='utf8')
    try:
        answer = execute(sys.stdin.buffer.read(1_500_001))
    except AuditFailure as error:
        raise SystemExit(EXIT_TIMEOUT if error.code == 'model_timeout' else 1) from None
    print(json.dumps(answer, ensure_ascii=False))


if __name__ == '__main__':
    main()
