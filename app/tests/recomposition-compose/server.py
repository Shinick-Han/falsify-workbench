from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
root=Path.cwd().resolve()
spike=(root/'../typesetter/.local/spike').resolve()
class Handler(SimpleHTTPRequestHandler):
 def translate_path(self,path):
  path=path.split('?')[0]
  if path.startswith('/spike/'):
   return str(spike / path.removeprefix('/spike/'))
  return super().translate_path(path)
 def do_POST(self):
  if self.path != '/result' or self.headers.get('Origin') != 'http://127.0.0.1:18766': self.send_error(403); return
  data=self.rfile.read(int(self.headers.get('Content-Length','0')))
  if not data.startswith(b'%PDF-') or len(data)>1000000: self.send_error(400); return
  (root/'.local/compose-proof/output.pdf').write_bytes(data)
  self.send_response(204); self.end_headers()
ThreadingHTTPServer(('127.0.0.1',18766),Handler).serve_forever()
