import hashlib
import threading
import unittest
from unittest.mock import patch
from test_paper_evidence import sample_pdf
from paper_evidence import EvidenceStore


class EvidencePublicationTests(unittest.TestCase):
    def test_slow_extract_does_not_hold_store_lock_and_duplicate_is_atomic(self):
        raw = sample_pdf(pages=1)
        digest = hashlib.sha256(raw).hexdigest()
        store = EvidenceStore()
        entered, release = threading.Event(), threading.Event()
        extract = store._extract
        results, errors = [], []

        def slow(*args):
            entered.set()
            if not release.wait(5):
                raise RuntimeError('test timeout')
            return extract(*args)

        def prepare():
            try:
                results.append(store.prepare(raw, digest))
            except Exception as exc:
                errors.append(exc)

        with patch.object(store, '_extract', side_effect=slow):
            threads = [threading.Thread(target=prepare) for _ in range(2)]
            for thread in threads: thread.start()
            try:
                self.assertTrue(entered.wait(5))
                self.assertTrue(store._lock.acquire(timeout=1))
                store._lock.release()
            finally:
                release.set()
                for thread in threads: thread.join(10)
        self.assertFalse(errors)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['paperId'], results[1]['paperId'])
        self.assertEqual(len(store._docs), 1)


if __name__ == '__main__': unittest.main()
