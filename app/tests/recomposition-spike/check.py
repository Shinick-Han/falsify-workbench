import re
from pathlib import Path
import pymupdf
p = Path('.local/spike/output.pdf')
data = p.read_bytes()
assert data.startswith(b'%PDF-')
doc = pymupdf.open(stream=data, filetype='pdf')
text = ''.join(page.get_text() for page in doc)
markers = [int(n) for n in re.findall(r'Paragraph (\d+):', text)]
assert markers == [n for n in range(1, 32) for _ in range(4)], markers
assert len(doc) >= 2 and 'Synthetic heading' in text and 'Synthetic figure caption' in text and 'Final marker.' in text
assert '\u03a9' in text
assert '\U0010ffff' not in text
origins = {round(block[0]) for page in doc for block in page.get_text('blocks')}
assert any(x < 100 for x in origins) and any(x > 300 for x in origins), origins
print('PASS', len(data), 'bytes,', len(doc), 'pages, 124 ordered markers, both columns, caption, Omega; unsupported glyph absent; origins', sorted(origins))
print('glyph probe extracted:', ascii(text[text.index('Glyph probe'):text.index('Paragraph 1')]))
print('embedded fonts:', doc[0].get_fonts())
