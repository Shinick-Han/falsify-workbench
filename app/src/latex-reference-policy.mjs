const diagnostic = (code, message) => ({code, message, severity: 'error'});

/** Return a bounded, explicit source replacement; never mutate the project. */
export function buildReferencePatch(project, node, {after, mode} = {}) {
  const diagnostics = [];
  const anchor = node && {projectId: project?.id, nodeId: node.id, path: node.path, start: node.start, end: node.end, kind: node.kind};
  const fail = (code, message) => ({anchor, afterSource: null, diagnostics: [diagnostic(code, message)]});
  if (!project || !node || typeof after !== 'string' || !['content', 'display-override'].includes(mode)) return fail('invalid-reference-edit', 'Choose a source node, replacement and edit mode.');
  const file = project.files?.find(f => f.path === node.path);
  if (!file || !Number.isInteger(node.start) || !Number.isInteger(node.end)) return fail('stale-anchor', 'The source node is no longer available; select it again.');
  const source = new TextDecoder('utf-8', {fatal:true}).decode(file.bytes);
  const original = source.slice(node.start, node.end);
  if (node.sourceText !== original) return fail('stale-anchor', 'The source changed; select the node again.');
  if (mode === 'content') {
    if (!Number.isInteger(node.contentStart) || !Number.isInteger(node.contentEnd) || node.contentStart < node.start || node.contentEnd > node.end) return fail('unsupported-content', 'Select editable source content.');
    let replacement = after;
    if (node.kind === 'citation') {
      if (!/^[A-Za-z0-9_:.\/-]+(?:\s*,\s*[A-Za-z0-9_:.\/-]+)*$/.test(after)) return fail('invalid-citation', 'Enter citation keys separated by commas.');
    } else if (node.kind === 'footnote' || node.kind === 'superscript' || node.kind === 'subscript' || node.kind === 'text') {
      const escapes = {'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
      replacement = after.replace(/[\\{}$&#%_~^]/g, c => escapes[c]);
    } else return fail('unsupported-content', 'Use the source content patch for this node.');
    return {anchor, afterSource:source.slice(node.start,node.contentStart) + replacement + source.slice(node.contentEnd,node.end), diagnostics};
  }
  if (!/^\d+$/.test(after)) return fail('invalid-marker', 'Enter a numeric display marker.');
  if (node.kind === 'superscript') {
    const match = /^(\\textsuperscript\s*\{)([^{}]*)(\})$/.exec(original);
    if (match) return {anchor, afterSource: match[1] + after + match[3], diagnostics};
  }
  if (node.kind === 'footnote') {
    // The ordinary footnote still advances its counter; the local definition changes only its printed mark.
    if (/^\\footnote\s*\{/.test(original) && original.endsWith('}')) return {anchor, afterSource: `\\begingroup\\renewcommand{\\thefootnote}{${after}}${original}\\endgroup`, diagnostics};
  }
  return fail('unsupported-display-override', 'This marker cannot be safely overridden. Edit its source explicitly or select a supported standard marker.');
}
