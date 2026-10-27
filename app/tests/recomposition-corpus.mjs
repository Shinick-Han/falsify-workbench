import * as mupdf from '../dist/browser-pdf-vendor/mupdf.js';
export const blocks = [
  {id:'a',text:'The result was -12 in study [3].'},
  {id:'b',text:'A second paragraph remains intact.'},
  {id:'c',text:'The selected sentence is short.'}
];
export const after = 'The selected sentence is longer and remains exact.';
const esc = s => s.replace(/[\\()]/g, '\\$&');
export function corpus(variant = 'baseline') {
  const d = new mupdf.PDFDocument(), font = d.addSimpleFont(new mupdf.Font('Helvetica'));
  let a = blocks[0].text, b = blocks[1].text, c = variant === 'edit' ? after : blocks[2].text;
  if (variant === 'missing') a = 'The result was -12 in study [ ].';
  if (variant === 'number') a = 'The result was -13 in study [3].';
  if (variant === 'sign') a = 'The result was 12 in study [3].';
  const line = (text,x,y) => `BT /F 12 Tf ${x} ${y} Td (${esc(text)}) Tj ET\n`;
  let p1 = variant === 'wrapped' ? line('The result was -12',30,350)+line('in study [3].',30,330) : line(a,variant === 'bounds' ? -10 : 30,350);
  p1 += line(b,30,300);
  if (variant === 'duplicate') p1 += line(b,30,275);
  if (variant === 'edit') p1 += line('The selected sentence is longer',30,250)+line('and remains exact.',30,230);
  else if (variant !== 'moved') p1 += line(c,30,250);
  d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},p1));
  if (variant === 'moved') d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{F:font}},line(c,30,350)));
  const buf=d.saveToBuffer(), bytes=buf.asUint8Array().slice(); buf.destroy(); d.destroy(); return bytes;
}

