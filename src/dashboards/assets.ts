import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { themeCss } from './core/palette';

export interface UiAssets {
  js: string;
  css: string;
}

let cached: Promise<UiAssets> | undefined;

function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * The dashboard bundle. A compiled harness reads dist/ui (built by `npm run build`); running
 * from source (tsx, Jest) bundles ui/ on the fly with esbuild so edits show up immediately.
 */
export function loadUiAssets(): Promise<UiAssets> {
  cached ??= (async () => {
    const root = packageRoot();
    const fromSource = __filename.endsWith('.ts');
    let js: string;
    let css: string;
    if (!fromSource) {
      js = await fsp.readFile(path.join(root, 'dist', 'ui', 'dashboard.js'), 'utf8');
      css = await fsp.readFile(path.join(root, 'dist', 'ui', 'dashboard.css'), 'utf8');
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { buildUi } = require(path.join(root, 'scripts', 'build-ui.js')) as {
        buildUi(o: { write: boolean }): Promise<{ js: string; css: string }>;
      };
      ({ js, css } = await buildUi({ write: false }));
    }
    return { js, css: `${themeCss()}\n${css}` };
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}
