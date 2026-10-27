from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path.cwd().resolve()
spike=(root/'../typesetter/.local/spike').resolve()
class Handler(SimpleHTTPRequestHandler):
 def translate_path(self,path):
  from urllib.parse import unquote, urlsplit
  path=unquote(urlsplit(path).path)
  if path.startswith('/spike/'):
   candidate=(spike / path.removeprefix('/spike/')).resolve()
   return str(candidate if candidate.is_relative_to(spike) else root/'__denied__')
  allowed={'/app/tests/recomposition-compose/index.html','/app/src/paper-compose.mjs','/app/src/paper-fonts.mjs','/app/src/paper-compose-check.mjs','/app/dist/vendor/pdf.mjs','/app/dist/vendor/pdf.worker.mjs'}
  return str(root/path.lstrip('/') if path in allowed else root/'__denied__')
 def do_POST(self):
  if self.path != '/result' or self.headers.get('Origin') != 'http://127.0.0.1:18766': self.send_error(403); return
  data=self.rfile.read(int(self.headers.get('Content-Length','0')))
  if not data.startswith(b'%PDF-') or len(data)>1000000: self.send_error(400); return
  (root/'.local/compose-proof/output.pdf').write_bytes(data)
  self.send_response(204); self.end_headers()
ThreadingHTTPServer(('127.0.0.1',18766),Handler).serve_forever()
