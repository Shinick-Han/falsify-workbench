"""Offline checks for the experimental 0.3.4 bundle. No model or network calls."""
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_profile
import runner

BASE = 'ef6c9678bb0258b182d1f7ecb22e2c70ff7b436d'
ID_SELECTION = {
    'type': 'object', 'additionalProperties': False, 'required': ['status', 'targets'],
    'properties': {
        'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
        'targets': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['referenceId', 'reason'],
            'properties': {'referenceId': {'type': 'string'}, 'reason': {'type': 'string'}},
        }},
    },
}


def no_network(*args, **kwargs):
    raise AssertionError('network')


class OfflineTests(unittest.TestCase):
    def invocation(self, settings, schema, prompt_body):
        return {
            'schema': 'falsify.harness-invocation.v1', 'role': 'blue', 'call': 1, 'maxCalls': 4,
            'prompt': runner.MARKER + '. ' + json.dumps(prompt_body, ensure_ascii=False),
            'outputSchema': schema, 'settings': settings,
        }

    def execute(self, settings, schema, response, fixture=None):
        raw_response = copy.deepcopy(response)
        stages = []

        def default_fixture(stage, prompt, out_schema, remaining):
            stages.append(stage)
            if stage != 'document-stage':
                raise AssertionError(stage)
            return {'status': 'ok', 'response': response, 'observed_tool_calls': 0}

        payload = json.dumps(self.invocation(settings, schema, {'segments': [{'id': 's1', 'text': 'Alpha'}]})).encode()
        with tempfile.TemporaryDirectory() as folder:
            try:
                answer = runner.execute(payload, fixture or default_fixture, no_network, folder)
                failure = None
            except runner.AuditFailure as error:
                answer, failure = None, error.code
            audits = list(Path(folder).glob('*.json'))
            self.assertEqual(len(audits), 1)
            audit = json.loads(audits[0].read_text(encoding='utf-8'))
        return answer, audit, failure, stages, raw_response

    def test_helper_tamper_changes_v034_bundle_only(self):
        before = runner.bundle_identity()
        inherited_before = runner.v033.bundle_identity()
        self.assertNotEqual(before, inherited_before)
        self.assertEqual(runner.v033.v2.digest(runner.inherited_sources()), inherited_before)
        self.assertNotIn(runner.HELPER_REL, runner.inherited_sources())
        self.assertIn('app/local/blue_service.py', runner.inherited_sources())
        self.assertIn(runner.HELPER_REL, runner.source_map())
        real = runner.read_bytes

        def tampered(path):
            data = real(path)
            if Path(path).name == 'blue_evidence_refs.py':
                return data + b'\n# tampered\n'
            return data

        runner.read_bytes = tampered
        try:
            self.assertNotEqual(runner.bundle_identity(), before)
            self.assertEqual(runner.v033.bundle_identity(), inherited_before)
            self.assertNotIn('blue_evidence_refs', (runner.V033_DIR / 'runner.py').read_text(encoding='utf-8'))
        finally:
            runner.read_bytes = real
        self.assertEqual(runner.bundle_identity(), before)

    def test_missing_unknown_and_stale_helper_fail_clearly(self):
        settings = runner.contract_settings()
        missing = settings
        real_path = runner.helper_path
        runner.helper_path = lambda: Path(tempfile.gettempdir()) / 'missing-blue-evidence-refs.py'
        try:
            answer, audit, failure, stages, _ = self.execute(missing, ID_SELECTION, {'status': 'abstain', 'targets': []})
        finally:
            runner.helper_path = real_path
        self.assertEqual((answer, failure, stages, audit['errorCode']), (None, 'helper_missing', [], 'helper_missing'))
        self.assertEqual(audit['modelCalls'], [])

        unknown = dict(settings)
        unknown['helper'] = 'app/local/not_the_evidence_helper.py'
        answer, audit, failure, stages, _ = self.execute(unknown, ID_SELECTION, {'status': 'abstain', 'targets': []})
        self.assertEqual(failure, 'helper_unknown')
        self.assertEqual(audit['errorCode'], 'helper_unknown')
        self.assertEqual(str(runner.AuditFailure('helper_unknown', {})), 'helper_unknown')

        alien = Path(tempfile.gettempdir()) / 'alien-blue-evidence-refs.py'
        alien.write_bytes(b'print("not the helper")\n')
        runner.helper_path = lambda: alien
        try:
            _, audit, failure, _, _ = self.execute(settings, ID_SELECTION, {'status': 'abstain', 'targets': []})
        finally:
            runner.helper_path = real_path
            alien.unlink(missing_ok=True)
        self.assertEqual((failure, audit['errorCode']), ('helper_unknown', 'helper_unknown'))

        stale = dict(settings)
        stale['helperSha256'] = '0' * 64
        _, audit, failure, stages, _ = self.execute(stale, ID_SELECTION, {'status': 'abstain', 'targets': []})
        self.assertEqual(failure, 'helper_stale')
        self.assertEqual(audit['errorCode'], 'helper_stale')
        self.assertEqual(stages, [])

    def test_profile_version_and_settings_agree(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = build_profile.build(Path(folder) / 'profile.json')
        settings = profile['settings']
        self.assertEqual(profile['id'], 'shinick-blue-evidence-external-v034')
        self.assertEqual(profile['version'], '0.3.4')
        self.assertEqual(settings['diagnosticVersion'], profile['version'])
        self.assertEqual(settings['auditSchema'], 'falsify.blue-evidence-audit.v0.3.4')
        self.assertEqual(settings['model'], 'claude-opus-5-5')
        self.assertEqual(settings['effort'], 'medium')
        self.assertEqual(settings['externalLookup'], {'enabled': True, 'providers': ['crossref', 'europepmc']})
        self.assertEqual(settings['internalMaxCalls'], 4)
        self.assertEqual(settings['scope'], runner.SCOPE)
        self.assertTrue(settings['experimental'])
        self.assertEqual(settings['bundleSha256'], runner.bundle_identity())
        self.assertEqual(settings['helper'], runner.HELPER_REL)
        self.assertEqual(settings['helperSha256'], runner.helper_digest())
        self.assertEqual(settings['inheritedSources'], runner.inherited_sources())
        self.assertEqual(profile['instructions'], runner.INSTRUCTIONS)
        self.assertTrue(Path(profile['adapter']['executable']).is_file())
        self.assertEqual(profile['adapter']['args'], [str(HERE / 'runner.py')])
        self.assertTrue(Path(profile['adapter']['args'][0]).is_absolute())
        audit_dir = Path(settings['auditDirectory'])
        self.assertTrue(audit_dir.is_absolute())
        self.assertEqual(audit_dir, runner.v033.REPO / '.local' / 'blue-evidence-v034-audits')
        self.assertNotIn(runner.HELPER_REL, settings['inheritedSources'])
        self.assertIn('app/local/blue_service.py', settings['inheritedSources'])
        template = (HERE / 'profile-template.json').read_text(encoding='utf-8')
        self.assertIn('"INSTALL_PY"', template)
        self.assertIn('"INSTALL_RUNNER"', template)
        self.assertIn('"INSTALL_AUDIT_DIR"', template)
        self.assertIn('GENERATED_AT_INSTALL', template)
        self.assertNotIn(str(runner.v033.REPO), template)
        self.assertNotIn(sys.executable, template)
        self.assertNotIn('sk-', template)
        built = json.dumps(profile)
        self.assertNotIn('INSTALL_', built)
        self.assertNotIn('GENERATED_AT_INSTALL', built)
        drifted = copy.deepcopy(settings)
        drifted['diagnosticVersion'] = '0.3.3'
        _, audit, failure, _, _ = self.execute(drifted, ID_SELECTION, {'status': 'abstain', 'targets': []})
        self.assertEqual(failure, 'settings_contract')
        self.assertEqual(audit['errorCode'], 'settings_contract')

    def test_targets_id_selection_skips_final_experts_and_keeps_raw_response(self):
        from blue_service import SELECTION
        self.assertIn('targets', SELECTION['properties'])
        self.assertNotIn('findings', SELECTION['properties'])
        response = {'status': 'ok', 'targets': [{'referenceId': 'er000000000001', 'reason': 'reread this span'}]}
        answer, audit, failure, stages, raw = self.execute(runner.contract_settings(), ID_SELECTION, response)
        self.assertIsNone(failure)
        self.assertEqual(stages, ['document-stage'])
        self.assertEqual(answer, raw)
        self.assertEqual(audit['modelCalls'][0]['response'], raw)
        self.assertIsNot(audit['modelCalls'][0]['response'], response)
        self.assertNotIn('scanDerivation', audit)
        self.assertEqual(audit['pipeline'], 'single-original-scan-or-selection; external lookup only at final review')
        self.assertEqual(audit['diagnosticVersion'], '0.3.4')
        self.assertEqual(audit['schema'], runner.AUDIT_SCHEMA)
        self.assertNotIn('statistics', json.dumps(stages))
        response['targets'][0]['reason'] = 'mutated after return'
        self.assertEqual(audit['modelCalls'][0]['response'], raw)
        self.assertEqual(audit['modelCalls'][0]['response']['targets'][0]['referenceId'], 'er000000000001')

    def test_old_source_files_unchanged(self):
        for rel, digest in runner.inherited_sources().items():
            disk = hashlib.sha256((runner.v033.REPO / rel).read_bytes()).hexdigest()
            self.assertEqual(disk, digest)
        changed = subprocess.check_output(
            ['git', 'diff', '--name-only', BASE], cwd=runner.v033.REPO, text=True).split()
        untracked = subprocess.check_output(
            ['git', 'ls-files', '--others', '--exclude-standard'], cwd=runner.v033.REPO, text=True).split()
        for path in set(changed) | set(untracked):
            self.assertTrue(
                path == 'docs/blue-evidence-v034.md' or path.startswith('app/examples/evidence_blue_v034/'),
                path,
            )


if __name__ == '__main__':
    unittest.main()
