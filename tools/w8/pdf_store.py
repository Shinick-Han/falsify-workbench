"""Private, content-addressed PDF storage behind the Workbench Worker."""
import contextlib
import datetime as dt
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import tempfile
import threading
import time

QUOTA = 2_000_000_000_000
MAX_PDF = 32 * 1024 * 1024
DAY = 24 * 3600
OBJECT = re.compile(r'/objects/([0-9a-f]{64})\Z')
LINK = re.compile(r'/links/([0-9a-f]{32})\.pdf\Z')
OWNER = re.compile(r'[A-Za-z0-9:_.-]{1,200}\Z')


class Invalid(Exception):
    def __init__(self, status):
        self.status = status


class Drive:
    def __init__(self, drive):
        self.drive = drive.rstrip('/')
        if not self.drive.endswith(':'):
            self.drive += '/'

    def path(self, digest):
        return self.drive + digest[:2] + '/' + digest + '.pdf'

    def run(self, *args):
        return subprocess.run(['rclone', *args, '--retries', '1', '--low-level-retries', '2'],
                              capture_output=True, timeout=90, check=True).stdout

    def put(self, digest, data):
        with tempfile.NamedTemporaryFile(suffix='.pdf') as file:
            file.write(data)
            file.flush()
            self.run('copyto', '--immutable', '--checksum', file.name, self.path(digest))

    def get(self, digest):
        return self.run('cat', self.path(digest))

    def archived_objects(self):
        # Used on first start or if the local ledger needs to be rebuilt from Drive.
        entries = json.loads(self.run('lsjson', '--recursive', '--files-only', self.drive))
        for item in entries:
            match = re.fullmatch(r'([0-9a-f]{2})/([0-9a-f]{64})\.pdf', item['Path'])
            if match and match[2].startswith(match[1]):
                yield match[2], int(item['Size'])

    def file_id(self, digest):
        item = json.loads(self.run('lsjson', '--stat', self.path(digest)))
        return item.get('ID')

    def exists(self, digest):
        try:
            return not json.loads(self.run('lsjson', '--stat', self.path(digest)))['IsDir']
        except subprocess.CalledProcessError as error:
            if error.returncode in (3, 4):
                return False
            raise


class Archive:
    def __init__(self, db_path, drive, limit=QUOTA, now=time.time):
        self.db_path, self.drive, self.limit, self.now = db_path, drive, min(limit, QUOTA), now
        self.locks = [threading.Lock() for _ in range(64)]
        with self.transaction() as db:
            db.execute('CREATE TABLE IF NOT EXISTS objects (sha TEXT PRIMARY KEY, size INTEGER NOT NULL, ready INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS drive_files (sha TEXT PRIMARY KEY, file_id TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS links (token TEXT PRIMARY KEY, owner TEXT NOT NULL, sha TEXT NOT NULL, expiry INTEGER NOT NULL, UNIQUE(owner,sha))')

    @contextlib.contextmanager
    def transaction(self):
        with contextlib.closing(sqlite3.connect(self.db_path, timeout=20)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            yield db

    def bootstrap(self):
        with self.transaction() as db:
            db.execute('CREATE TABLE IF NOT EXISTS initialized (id INTEGER PRIMARY KEY)')
            if db.execute('SELECT id FROM initialized LIMIT 1').fetchone():
                return
            db.executemany('INSERT OR IGNORE INTO objects(sha,size,ready) VALUES(?,?,1)',
                           self.drive.archived_objects())
            db.execute('INSERT INTO initialized VALUES(1)')

    def reserve(self, digest, size):
        with self.transaction() as db:
            row = db.execute('SELECT ready FROM objects WHERE sha=?', (digest,)).fetchone()
            if row:
                return not row[0]
            used = db.execute('SELECT COALESCE(SUM(size),0) FROM objects').fetchone()[0]
            if used + size > self.limit:
                raise Invalid(507)
            db.execute('INSERT INTO objects VALUES(?,?,0)', (digest, size))
            return True

    def recover(self, digest):
        # An uncertain upload keeps its reservation until Drive confirms the outcome.
        present = self.drive.exists(digest)
        with self.transaction() as db:
            if present:
                db.execute('UPDATE objects SET ready=1 WHERE sha=? AND ready=0', (digest,))
            else:
                db.execute('DELETE FROM objects WHERE sha=? AND ready=0', (digest,))

    def recover_pending(self):
        with self.transaction() as db:
            pending = list(db.execute('SELECT sha FROM objects WHERE ready=0'))
        for (digest,) in pending:
            self.recover(digest)

    def object_lock(self, digest):
        return self.locks[int(digest[:2], 16) % len(self.locks)]

    def drive_file_id(self, digest):
        with self.transaction() as db:
            row = db.execute('SELECT file_id FROM drive_files WHERE sha=?', (digest,)).fetchone()
        if row:
            return row[0]
        try:
            file_id = self.drive.file_id(digest)
        except (OSError, subprocess.SubprocessError, ValueError):
            return None
        if not isinstance(file_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{10,180}', file_id):
            return None
        with self.transaction() as db:
            db.execute('INSERT OR IGNORE INTO drive_files VALUES(?,?)', (digest, file_id))
        return file_id

    def put(self, digest, owner, data):
        if not data.startswith(b'%PDF-') or hashlib.sha256(data).hexdigest() != digest:
            raise Invalid(400)
        with self.object_lock(digest):
            if self.reserve(digest, len(data)):
                try:
                    self.drive.put(digest, data)
                except (OSError, subprocess.SubprocessError):
                    self.recover(digest)
                    raise
                with self.transaction() as db:
                    db.execute('UPDATE objects SET ready=1 WHERE sha=?', (digest,))
            now = int(self.now())
            with self.transaction() as db:
                row = db.execute('SELECT token,expiry FROM links WHERE owner=? AND sha=?', (owner, digest)).fetchone()
                if not row or row[1] <= now:
                    row = (secrets.token_hex(16), now + DAY)
                    db.execute('INSERT OR REPLACE INTO links(token,owner,sha,expiry) VALUES(?,?,?,?)',
                               (row[0], owner, digest, row[1]))
        expiry = dt.datetime.fromtimestamp(row[1], dt.timezone.utc).isoformat()
        result = {'token': row[0], 'sha256': digest, 'expiresAt': expiry}
        file_id = self.drive_file_id(digest)
        if file_id:
            result['driveFileId'] = file_id
        return result

    def lookup(self, token):
        with self.transaction() as db:
            row = db.execute('SELECT sha,size FROM links JOIN objects USING(sha) WHERE token=? AND expiry>? AND ready=1',
                             (token, int(self.now()))).fetchone()
        if not row:
            raise Invalid(404)
        return row

    def revoke(self, match, owner):
        token_lookup = match.re is LINK
        lock = contextlib.nullcontext() if token_lookup else self.object_lock(match[1])
        with lock, self.transaction() as db:
            if token_lookup:
                row = db.execute('SELECT owner FROM links WHERE token=?', (match[1],)).fetchone()
                if row and row[0] != owner:
                    raise Invalid(403)
                db.execute('DELETE FROM links WHERE owner=? AND token=?', (owner, match[1]))
            else:
                db.execute('DELETE FROM links WHERE owner=? AND sha=?', (owner, match[1]))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Request paths contain bearer links.

    def respond(self, status, body=b'', mime='application/json', size=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body) if size is None else size))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def dispatch(self):
        store = self.server.archive
        supplied = self.headers.get('X-Falsify-Store-Token', '').encode()
        if not hmac.compare_digest(supplied, self.server.token):
            raise Invalid(401)
        obj, link = OBJECT.fullmatch(self.path), LINK.fullmatch(self.path)
        if not obj and not link:
            raise Invalid(404)
        if link and self.command in ('GET', 'HEAD'):
            digest, size = store.lookup(link[1])
            data = b'' if self.command == 'HEAD' else store.drive.get(digest)
            if self.command == 'GET' and hashlib.sha256(data).hexdigest() != digest:
                raise Invalid(503)
            return self.respond(200, data, 'application/pdf', size)
        owner = self.headers.get('X-Falsify-Owner', '')
        if not OWNER.fullmatch(owner):
            raise Invalid(401)
        if self.command == 'DELETE':
            store.revoke(obj or link, owner)
            return self.respond(204)
        if obj and self.command == 'PUT':
            length = self.headers.get('Content-Length', '')
            if not length.isdecimal():
                raise Invalid(411)
            size = int(length)
            if size > MAX_PDF:
                raise Invalid(413)
            data = self.rfile.read(size)
            result = store.put(obj[1], owner, data)
            return self.respond(200, json.dumps(result).encode())
        raise Invalid(405)

    def handle_request(self):
        try:
            self.connection.settimeout(90)
            self.dispatch()
        except Invalid as error:
            self.respond(error.status)
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            self.respond(503)

    do_PUT = do_GET = do_HEAD = do_DELETE = handle_request


if __name__ == '__main__':
    os.umask(0o077)
    root = Path(os.environ['W8_PDF_STATE_DIR'])
    root.mkdir(parents=True, exist_ok=True)
    drive = Drive(os.environ['W8_PDF_DRIVE'])
    with http.server.ThreadingHTTPServer(('127.0.0.1', int(os.getenv('W8_PDF_PORT','18241'))), Handler) as server:
        server.token = os.environ['W8_PDF_STORE_TOKEN'].encode()
        if not server.token:
            raise ValueError('Missing private store credential')
        server.archive = Archive(root / 'archive.sqlite3', drive)
        server.archive.bootstrap()
        server.archive.recover_pending()
        server.serve_forever()
