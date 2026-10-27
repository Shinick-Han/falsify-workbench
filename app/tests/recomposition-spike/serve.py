from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/save-synthetic' or self.headers.get('Origin') != 'http://127.0.0.1:18765':
            self.send_error(403); return
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size < 1000000:
            self.send_error(400); return
        data = self.rfile.read(size)
        if not data.startswith(b'%PDF-'):
            self.send_error(400); return
        Path('.local/spike/output.pdf').write_bytes(data)
        self.send_response(204); self.end_headers()
ThreadingHTTPServer(('127.0.0.1', 18765), Handler).serve_forever()
