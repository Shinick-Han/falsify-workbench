// Keep the existing engine mounts and their normal production configuration.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const path = name => fileURLToPath(new URL(name, import.meta.url));
const read = name => readFileSync(path(name), 'utf8');
const paperApi = 'https://falsify-w8-papers.ai-gongbu.workers.dev';
const teamApi = 'https://falsify-cloud-api-staging.ai-gongbu.workers.dev';
const shell = read('workbench-shell.html')
  .replace('{{PAPER_SEARCH_API}}', paperApi)
  .replace('{{TEAM_API}}', teamApi);
const index = read('../app/dist/index.html');
const assets = ['booth-edits', 'booth', 'booth-recipe', 'booth-myai', 'booth-pageedit', 'w8-paper', 'w8-paper-links', 'w8-matcher', 'w8-blue', 'w8-csv', 'w8-red-key', 'w8-team', 'w8-paper-sync', 'w8-library', 'w8-history', 'w8-grading', 'w8-workbench'];
function assetUrl(file) {
  const version = createHash('sha256').update(read('../app/dist/' + file)).digest('hex').slice(0, 12);
  return file + '?v=' + version;
}
const scripts = assets.map(name => '  <script src="' + assetUrl(name + '.js') + '" defer></script>').join('\n');
const styles = ['event-theme.css', 'booth.css', 'booth-recipe.css', 'booth-myai.css', 'booth-pageedit.css', 'w8-workbench.css']
  .map(name => '  <link rel="stylesheet" href="' + assetUrl(name) + '">').join('\n');
const html = index
  // The legacy shell owns its own navigation and rewrites its entry URL to #red.
  .replace(/^.*src="app\.js\?[^\n]*\n/gm, '')
  .replace(/^.*(?:src|href)="(?:latex-workbench\.(?:mjs|css)|red-baseline-uri\.(?:js|css))\?[^\n]*\n/gm, '')
  .replace("connect-src 'self'", "connect-src 'self' " + paperApi + ' ' + teamApi)
  .replace(/src="(open-access|external-exchange)\.js\?[^"]+"/g, (_, name) => 'src="' + assetUrl(name + '.js') + '"')
  .replace('<html lang="ko">', '<html lang="ko" data-w8-workbench>')
  .replace('</head>', '  <meta name="color-scheme" content="only light">\n' + styles + '\n' + scripts + '\n</head>')
  .replace('<body>', '<body>\n' + shell + '\n<div hidden id="w8-engine-mounts">')
  .replace('</body>', '</div>\n</body>');
const output = '../app/dist/workbench.html';
if (process.argv.includes('--check')) {
  if (read(output) !== html) throw new Error('Regenerate the workbench with node scripts/build-workbench-page.mjs');
} else {
  writeFileSync(path(output), html);
}
