/**
 * Bundle the dashboard components (ui/) into one script and one stylesheet. The renderer
 * inlines both into every dashboard, so a dashboard is a single self-contained file.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

async function buildUi({ outdir = path.join(ROOT, 'dist', 'ui'), write = true, minify = true } = {}) {
  const esbuild = require('esbuild');
  const common = { bundle: true, minify, write, logLevel: 'silent', legalComments: 'none' };
  const js = await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'ui', 'main.ts')],
    outfile: path.join(outdir, 'dashboard.js'),
    format: 'iife',
    target: ['es2020'],
  });
  const css = await esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, 'ui', 'styles.css')],
    outfile: path.join(outdir, 'dashboard.css'),
  });
  if (write) return { js: null, css: null };
  return { js: js.outputFiles[0].text, css: css.outputFiles[0].text };
}

module.exports = { buildUi };

if (require.main === module) {
  buildUi().then(
    () => console.log('built dist/ui/dashboard.js and dist/ui/dashboard.css'),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
