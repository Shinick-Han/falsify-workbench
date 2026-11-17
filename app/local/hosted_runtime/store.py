"""Durable, owner-bound SQLite state and content-addressed blobs.

No job state lives only in memory: every accepted job, progress mark, result, failure and
artifact is committed here before it is reported.  Blobs are written with a temp file,
fsync and atomic rename, then referenced by SHA-256.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 3
TERMINAL_STATES = frozenset({'cancelled', 'completed', 'failed', 'interrupted'})
ACTIVE_STATES = ('queued', 'running', 'cancelling')
_UNSET = object()


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _load(value):
    return None if value is None else json.loads(value)


class StoreError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class StoreNotFound(StoreError):
    def __init__(self):
        super().__init__('not_found')


class IdempotencyConflict(StoreError):
    def __init__(self):
        super().__init__('idempotency_conflict')


class JobIdConflict(StoreError):
    def __init__(self):
        super().__init__('job_id_conflict')


class Store:
    """Durable state for one state directory; RuntimeService enforces a single writer."""

    def __init__(self, state_dir):
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if os.name != 'nt':
            try:
                os.chmod(self.state_dir, 0o700)
            except OSError:
                pass
        self.blob_dir = self.state_dir / 'blobs'
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.state_dir / 'state.sqlite3'
        self._initialise()

    # ---------------------------------------------------------------- connection
    def _raw_connection(self):
        conn = sqlite3.connect(str(self.db_path), timeout=10.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA busy_timeout=10000')
            conn.execute('PRAGMA foreign_keys=ON')
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA synchronous=FULL')
        except Exception:
            conn.close()
            raise
        return conn

    @contextlib.contextmanager
    def _read(self):
        conn = self._raw_connection()
        try:
            yield conn
        finally:
            conn.close()

    @contextlib.contextmanager
    def _write(self):
        conn = self._raw_connection()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                yield conn
            except BaseException:
                conn.execute('ROLLBACK')
                raise
            else:
                conn.execute('COMMIT')
        finally:
            conn.close()

    def _initialise(self):
        conn = self._raw_connection()
        try:
            conn.execute('BEGIN IMMEDIATE')
            try:
                version = conn.execute('PRAGMA user_version').fetchone()[0]
                if version > SCHEMA_VERSION:
                    raise StoreError('state_schema_unsupported')
                if version not in (0, 1, 2, SCHEMA_VERSION):
                    raise StoreError('state_schema_unsupported')
                conn.execute("""CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL)""")
                meta_row = conn.execute("SELECT value FROM schema_meta WHERE key='version'").fetchone()
                if meta_row is not None:
                    try:
                        recorded = int(meta_row['value'])
                    except (TypeError, ValueError):
                        raise StoreError('state_schema_unsupported') from None
                    if recorded not in (version, SCHEMA_VERSION):
                        raise StoreError('state_schema_unsupported')
                conn.execute("""CREATE TABLE IF NOT EXISTS uploads (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    name TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(owner_id, sha256))""")
                conn.execute("""CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    request_hash TEXT NOT NULL,
                    role TEXT NOT NULL,
                    state TEXT NOT NULL,
                    progress TEXT NOT NULL,
                    model TEXT NOT NULL,
                    effort TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    usage TEXT,
                    result TEXT,
                    failure TEXT,
                    provider_request_id TEXT,
                    apply_only INTEGER NOT NULL DEFAULT 0,
                    use_evidence INTEGER NOT NULL DEFAULT 1,
                    upload_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    completed_at TEXT,
                    UNIQUE(owner_id, idempotency_key))""")
                conn.execute("""CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                    owner_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    bytes INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(job_id, name))""")
                conn.execute('CREATE INDEX IF NOT EXISTS jobs_owner_state ON jobs(owner_id, state)')
                conn.execute('CREATE INDEX IF NOT EXISTS artifacts_job ON artifacts(job_id)')
                if version == 1:
                    columns = {row['name'] for row in
                               conn.execute('PRAGMA table_info(jobs)').fetchall()}
                    if 'apply_only' not in columns:
                        conn.execute('ALTER TABLE jobs ADD COLUMN apply_only INTEGER NOT NULL DEFAULT 0')
                    if 'use_evidence' not in columns:
                        conn.execute('ALTER TABLE jobs ADD COLUMN use_evidence INTEGER NOT NULL DEFAULT 1')
                if version in (1, 2):
                    columns = {row['name'] for row in
                               conn.execute('PRAGMA table_info(jobs)').fetchall()}
                    if 'upload_id' not in columns:
                        conn.execute('ALTER TABLE jobs ADD COLUMN upload_id TEXT')
                if version in (0, 1, 2):
                    conn.execute('PRAGMA user_version=%d' % SCHEMA_VERSION)
                conn.execute("INSERT INTO schema_meta(key, value) VALUES('version', ?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                             (str(SCHEMA_VERSION),))
                conn.execute('COMMIT')
            except BaseException:
                conn.execute('ROLLBACK')
                raise
        finally:
            conn.close()

    # ---------------------------------------------------------------------- blobs
    def _blob_path(self, sha):
        return self.blob_dir / sha[:2] / sha

    def _fsync_dir(self, path):
        try:
            fd = os.open(str(path), os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(fd)
        except OSError:
            pass
        finally:
            os.close(fd)

    def _write_blob(self, data):
        sha = hashlib.sha256(data).hexdigest()
        path = self._blob_path(sha)
        if path.is_file():
            return sha
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.parent / ('.tmp-' + uuid.uuid4().hex)
        try:
            with open(tmp, 'xb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
            self._fsync_dir(path.parent)
        finally:
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass
        return sha

    def _read_blob(self, sha, expected_bytes=None):
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise StoreError('state_corrupt')
        path = self._blob_path(sha)
        try:
            data = path.read_bytes()
        except OSError:
            raise StoreError('state_corrupt') from None
        if hashlib.sha256(data).hexdigest() != sha:
            raise StoreError('state_corrupt')
        if expected_bytes is not None and len(data) != expected_bytes:
            raise StoreError('state_corrupt')
        return data

    # -------------------------------------------------------------------- uploads
    @staticmethod
    def _upload(row):
        return {
            'id': row['id'],
            'ownerId': row['owner_id'],
            'sha256': row['sha256'],
            'name': row['name'],
            'mime': row['mime'],
            'bytes': row['bytes'],
            'createdAt': row['created_at'],
        }

    def put_upload(self, owner_id, name, mime, data):
        """Content-addressed per owner.  Returns ``(upload, created)``."""
        raw = bytes(data)
        sha = hashlib.sha256(raw).hexdigest()
        with self._read() as conn:
            row = conn.execute('SELECT * FROM uploads WHERE owner_id=? AND sha256=?',
                               (owner_id, sha)).fetchone()
        if row is not None:
            return self._upload(row), False
        self._write_blob(raw)
        upload_id = str(uuid.uuid4())
        created_at = utc_now()
        with self._write() as conn:
            row = conn.execute('SELECT * FROM uploads WHERE owner_id=? AND sha256=?',
                               (owner_id, sha)).fetchone()
            if row is not None:
                return self._upload(row), False
            try:
                conn.execute('INSERT INTO uploads(id, owner_id, sha256, name, mime, bytes, created_at) '
                             'VALUES(?, ?, ?, ?, ?, ?, ?)',
                             (upload_id, owner_id, sha, name, mime, len(raw), created_at))
            except sqlite3.IntegrityError:
                row = conn.execute('SELECT * FROM uploads WHERE owner_id=? AND sha256=?',
                                   (owner_id, sha)).fetchone()
                if row is not None:
                    return self._upload(row), False
                raise
            row = conn.execute('SELECT * FROM uploads WHERE id=?', (upload_id,)).fetchone()
            return self._upload(row), True

    def get_upload(self, owner_id, upload_id):
        with self._read() as conn:
            row = conn.execute('SELECT * FROM uploads WHERE owner_id=? AND id=?',
                               (owner_id, upload_id)).fetchone()
        if row is None:
            raise StoreNotFound()
        return self._upload(row)

    def read_upload_bytes(self, owner_id, upload_id):
        upload = self.get_upload(owner_id, upload_id)
        return upload, self._read_blob(upload['sha256'], upload['bytes'])

    # ----------------------------------------------------------------------- jobs
    @staticmethod
    def _job(row):
        return {
            'id': row['id'],
            'ownerId': row['owner_id'],
            'idempotencyKey': row['idempotency_key'],
            'requestHash': row['request_hash'],
            'role': row['role'],
            'state': row['state'],
            'progress': _load(row['progress']),
            'model': row['model'],
            'effort': row['effort'],
            'provider': row['provider'],
            'usage': _load(row['usage']),
            'result': _load(row['result']),
            'failure': _load(row['failure']),
            'providerRequestId': row['provider_request_id'],
            'applyOnly': bool(row['apply_only']),
            'useEvidence': bool(row['use_evidence']),
            'uploadId': row['upload_id'],
            'createdAt': row['created_at'],
            'updatedAt': row['updated_at'],
            'completedAt': row['completed_at'],
        }

    def create_job(self, *, owner_id, job_id, idempotency_key, request_hash, role,
                   model, effort, provider, progress, apply_only=False, use_evidence=True,
                   upload_id=None):
        """Insert a queued job or return the existing idempotent job."""
        now = utc_now()
        with self._write() as conn:
            row = conn.execute('SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?',
                               (owner_id, idempotency_key)).fetchone()
            if row is not None:
                if row['request_hash'] != request_hash:
                    raise IdempotencyConflict()
                return self._job(row), False
            if conn.execute('SELECT 1 FROM jobs WHERE id=?', (job_id,)).fetchone() is not None:
                raise JobIdConflict()
            try:
                conn.execute(
                    'INSERT INTO jobs(id, owner_id, idempotency_key, request_hash, role, state, '
                    'progress, model, effort, provider, apply_only, use_evidence, upload_id, '
                    'created_at, updated_at) '
                    'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (job_id, owner_id, idempotency_key, request_hash, role, 'queued',
                     _dump(progress), model, effort, provider, 1 if apply_only else 0,
                     1 if use_evidence else 0, upload_id, now, now))
            except sqlite3.IntegrityError:
                row = conn.execute('SELECT * FROM jobs WHERE owner_id=? AND idempotency_key=?',
                                   (owner_id, idempotency_key)).fetchone()
                if row is not None and row['request_hash'] == request_hash:
                    return self._job(row), False
                if row is not None:
                    raise IdempotencyConflict() from None
                raise JobIdConflict() from None
            row = conn.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            return self._job(row), True

    def get_job(self, owner_id, job_id):
        with self._read() as conn:
            row = conn.execute('SELECT * FROM jobs WHERE owner_id=? AND id=?',
                               (owner_id, job_id)).fetchone()
        if row is None:
            raise StoreNotFound()
        return self._job(row)

    def transition(self, owner_id, job_id, from_states, to_state, *, progress=_UNSET,
                   result=_UNSET, usage=_UNSET, failure=_UNSET,
                   provider_request_id=_UNSET, completed=False):
        if not isinstance(from_states, (tuple, list, set, frozenset)) or not from_states:
            raise ValueError('from_states required')
        now = utc_now()
        fields = ['state=?', 'updated_at=?']
        params = [to_state, now]
        if progress is not _UNSET:
            fields.append('progress=?')
            params.append(_dump(progress))
        if result is not _UNSET:
            fields.append('result=?')
            params.append(_dump(result))
        if usage is not _UNSET:
            fields.append('usage=?')
            params.append(None if usage is None else _dump(usage))
        if failure is not _UNSET:
            fields.append('failure=?')
            params.append(None if failure is None else _dump(failure))
        if provider_request_id is not _UNSET:
            fields.append('provider_request_id=?')
            params.append(provider_request_id)
        if completed:
            fields.append('completed_at=?')
            params.append(now)
        placeholders = ', '.join('?' for _ in from_states)
        params.extend([job_id, owner_id, *from_states])
        with self._write() as conn:
            cursor = conn.execute(
                'UPDATE jobs SET ' + ', '.join(fields) +
                ' WHERE id=? AND owner_id=? AND state IN (' + placeholders + ')', params)
            return cursor.rowcount == 1

    def update_progress(self, owner_id, job_id, progress):
        with self._write() as conn:
            cursor = conn.execute(
                "UPDATE jobs SET progress=?, updated_at=? "
                "WHERE id=? AND owner_id=? AND state='running'",
                (_dump(progress), utc_now(), job_id, owner_id))
            return cursor.rowcount == 1

    def request_cancel(self, owner_id, job_id):
        with self._read() as conn:
            row = conn.execute('SELECT * FROM jobs WHERE owner_id=? AND id=?',
                               (owner_id, job_id)).fetchone()
        if row is None:
            raise StoreNotFound()
        if row['state'] in TERMINAL_STATES:
            return self._job(row)
        with self._write() as conn:
            conn.execute(
                "UPDATE jobs SET state='cancelling', updated_at=? "
                "WHERE id=? AND owner_id=? AND state IN ('queued', 'running', 'cancelling')",
                (utc_now(), job_id, owner_id))
            row = conn.execute('SELECT * FROM jobs WHERE owner_id=? AND id=?',
                               (owner_id, job_id)).fetchone()
            return self._job(row)

    def mark_recovered(self, failure):
        """Mark queued/running/cancelling jobs interrupted; never schedules a replay."""
        now = utc_now()
        payload = _dump(failure)
        with self._write() as conn:
            cursor = conn.execute(
                "UPDATE jobs SET state='interrupted', failure=?, updated_at=?, "
                "completed_at=COALESCE(completed_at, ?) "
                "WHERE state IN ('queued', 'running', 'cancelling')",
                (payload, now, now))
            return cursor.rowcount

    # ------------------------------------------------------------------ artifacts
    @staticmethod
    def _artifact(row):
        return {
            'id': row['id'],
            'name': row['name'],
            'mime': row['mime'],
            'bytes': row['bytes'],
            'sha256': row['sha256'],
        }

    def _insert_artifact(self, conn, owner_id, job_id, name, mime, sha, size, created_at):
        row = conn.execute('SELECT * FROM artifacts WHERE job_id=? AND name=?',
                           (job_id, name)).fetchone()
        if row is not None:
            if row['sha256'] == sha:
                return self._artifact(row)
            raise StoreError('artifact_conflict')
        artifact_id = str(uuid.uuid4())
        conn.execute('INSERT INTO artifacts(id, job_id, owner_id, name, mime, bytes, sha256, created_at) '
                     'VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
                     (artifact_id, job_id, owner_id, name, mime, size, sha, created_at))
        row = conn.execute('SELECT * FROM artifacts WHERE id=?', (artifact_id,)).fetchone()
        return self._artifact(row)

    def add_artifact(self, owner_id, job_id, name, mime, data):
        raw = bytes(data)
        sha = hashlib.sha256(raw).hexdigest()
        self._write_blob(raw)
        with self._write() as conn:
            job = conn.execute('SELECT 1 FROM jobs WHERE id=? AND owner_id=?',
                               (job_id, owner_id)).fetchone()
            if job is None:
                raise StoreNotFound()
            return self._insert_artifact(conn, owner_id, job_id, name, mime, sha,
                                         len(raw), utc_now())

    def complete_job(self, owner_id, job_id, *, result, result_bytes, usage,
                     provider_request_id=None, artifact_name='review.json',
                     artifact_mime='application/json'):
        """Atomically persist the result and its review artifact, then mark completed."""
        raw = bytes(result_bytes)
        sha = hashlib.sha256(raw).hexdigest()
        self._write_blob(raw)
        now = utc_now()
        with self._write() as conn:
            row = conn.execute('SELECT state FROM jobs WHERE id=? AND owner_id=?',
                               (job_id, owner_id)).fetchone()
            if row is None:
                raise StoreNotFound()
            if row['state'] != 'running':
                return False
            conn.execute(
                "UPDATE jobs SET state='completed', result=?, usage=?, provider_request_id=?, "
                "completed_at=?, updated_at=? WHERE id=? AND owner_id=? AND state='running'",
                (_dump(result), _dump(usage) if usage is not None else None,
                 provider_request_id, now, now, job_id, owner_id))
            self._insert_artifact(conn, owner_id, job_id, artifact_name, artifact_mime,
                                  sha, len(raw), now)
            return True

    def list_artifacts(self, owner_id, job_id):
        with self._read() as conn:
            job = conn.execute('SELECT 1 FROM jobs WHERE id=? AND owner_id=?',
                               (job_id, owner_id)).fetchone()
            if job is None:
                raise StoreNotFound()
            rows = conn.execute('SELECT * FROM artifacts WHERE job_id=? ORDER BY created_at, rowid',
                                (job_id,)).fetchall()
            return [self._artifact(row) for row in rows]

    def get_artifact(self, owner_id, job_id, artifact_id):
        with self._read() as conn:
            row = conn.execute(
                'SELECT a.* FROM artifacts a JOIN jobs j ON j.id=a.job_id '
                'WHERE j.owner_id=? AND a.job_id=? AND a.id=?',
                (owner_id, job_id, artifact_id)).fetchone()
        if row is None:
            raise StoreNotFound()
        data = self._read_blob(row['sha256'], row['bytes'])
        return self._artifact(row), data

    # ------------------------------------------------------------------ retention
    def prune_jobs(self, *, retention_seconds, now=None):
        """Delete terminal jobs and unreferenced uploads outside the retention window."""
        if not retention_seconds or retention_seconds <= 0:
            return 0
        current = time.time() if now is None else float(now)
        cutoff_iso = datetime.fromtimestamp(current - retention_seconds, timezone.utc).isoformat(
            timespec='milliseconds').replace('+00:00', 'Z')
        with self._write() as conn:
            rows = conn.execute(
                "SELECT id FROM jobs WHERE state IN ('cancelled', 'completed', 'failed', 'interrupted') "
                "AND COALESCE(completed_at, updated_at) < ?", (cutoff_iso,)).fetchall()
            job_ids = [row['id'] for row in rows]
            for job_id in job_ids:
                conn.execute('DELETE FROM jobs WHERE id=?', (job_id,))
            uploads = conn.execute(
                "DELETE FROM uploads WHERE created_at < ? "
                "AND id NOT IN (SELECT upload_id FROM jobs WHERE upload_id IS NOT NULL)",
                (cutoff_iso,)).rowcount
        if job_ids or uploads:
            self._collect_blobs()
        return len(job_ids)

    def _collect_blobs(self):
        with self._read() as conn:
            referenced = {row['sha256'] for row in
                          conn.execute('SELECT sha256 FROM uploads UNION SELECT sha256 FROM artifacts')}
        try:
            candidates = list(self.blob_dir.glob('*/*'))
        except OSError:
            return
        for path in candidates:
            if path.name.startswith('.tmp-'):
                continue
            if path.name not in referenced:
                try:
                    path.unlink()
                except OSError:
                    pass

    def ping(self):
        try:
            with self._read() as conn:
                conn.execute('SELECT 1').fetchone()
            return True
        except Exception:
            return False
