from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock

from pdf_store import Archive, DAY, Invalid, OBJECT, QUOTA


def sha(data):
    return hashlib.sha256(data).hexdigest()


class DriveFixture:
    def __init__(self):
        self.files = {}
        self.puts = 0

    def put(self, digest, data):
        self.files[digest] = data
        self.puts += 1

    def file_id(self, digest):
        return 'drive_' + digest if digest in self.files else None

    def exists(self, digest):
        return digest in self.files

    def archived_objects(self):
        return [(key, len(value)) for key, value in self.files.items()]


class StoreTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / 'store.sqlite'
        self.drive = DriveFixture()
        self.now = 10000
        self.a, self.b = b'%PDF-a', b'%PDF-b'
        self.store = Archive(self.path, self.drive, len(self.a), lambda: self.now)
        self.store.bootstrap()

    def put(self, data, owner='A'):
        return self.store.put(sha(data), owner, data)

    def test_authenticated_upload_includes_stable_private_drive_file(self):
        first = self.put(self.a)
        self.assertEqual(first['driveFileId'], self.drive.file_id(sha(self.a)))
        self.drive.file_id = Mock(side_effect=OSError())
        self.assertEqual(self.put(self.a, 'B')['driveFileId'], first['driveFileId'])
        self.assertEqual(self.store.lookup(first['token']), (sha(self.a), len(self.a)))

    def test_duplicate_owners_expiry_and_revoke(self):
        with ThreadPoolExecutor(max_workers=4) as workers:
            links = list(workers.map(lambda owner: self.put(self.a, owner)['token'], ['A','B','A','B']))
        self.assertEqual(self.drive.puts, 1)
        self.assertEqual(links[:2], links[2:])
        self.assertNotEqual(*links[:2])
        self.store.revoke(OBJECT.fullmatch('/objects/' + sha(self.a)), 'A')
        with self.assertRaises(Invalid) as revoked:
            self.store.lookup(links[0])
        self.assertEqual(revoked.exception.status, 404)
        self.assertEqual(self.store.lookup(links[1]), (sha(self.a), len(self.a)))
        self.now += DAY
        with self.assertRaises(Invalid):
            self.store.lookup(links[1])
        self.assertNotEqual(self.put(self.a, 'B')['token'], links[1])
        self.assertEqual(self.drive.puts, 1)

    def test_inflight_bytes_count_and_remain_counted_after_restart(self):
        writing, release = threading.Event(), threading.Event()
        put = self.drive.put
        def slow(digest, data):
            writing.set()
            release.wait(5)
            put(digest, data)
        self.drive.put = slow
        with ThreadPoolExecutor() as pool:
            first = pool.submit(self.put, self.a)
            self.assertTrue(writing.wait(5))
            try:
                with self.assertRaises(Invalid) as over:
                    self.put(self.b)
                self.assertEqual(over.exception.status, 507)
            finally:
                release.set()
            token = first.result()['token']
        recovered = Archive(self.path, self.drive, len(self.a), lambda: self.now)
        recovered.bootstrap()
        self.assertEqual(recovered.lookup(token)[0], sha(self.a))
        with self.assertRaises(Invalid):
            recovered.put(sha(self.b), 'C', self.b)
        self.assertEqual(Archive(self.path, self.drive, QUOTA+1).limit, QUOTA)

    def test_rebuild_ledger_from_remote(self):
        self.put(self.a)
        self.path.unlink()
        recovered = Archive(self.path, self.drive, len(self.a), lambda: self.now)
        recovered.bootstrap()
        with self.assertRaises(Invalid):
            recovered.put(sha(self.b), 'A', self.b)
        recovered.put(sha(self.a), 'A', self.a)
        self.assertEqual(self.drive.puts, 1)

    def test_interrupted_and_unknown_uploads(self):
        put = self.drive.put
        self.drive.put = Mock(side_effect=OSError())
        with self.assertRaises(OSError):
            self.put(self.a)
        self.assertFalse(self.drive.files)
        self.drive.exists = Mock(side_effect=OSError())
        with self.assertRaises(OSError):
            self.put(self.a)
        with self.assertRaises(Invalid) as full:
            self.put(self.b)
        self.assertEqual(full.exception.status, 507)
        self.drive.exists = lambda d: d in self.drive.files
        self.store.recover_pending()
        self.drive.put = put
        self.put(self.b)
        self.assertEqual(self.drive.puts, 1)

if __name__ == '__main__':
    unittest.main()
