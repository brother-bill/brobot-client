/**
 * Bundles the Electron main + preload entry points (the same shape as
 * apps/mediabot/electron/esbuild.mjs).
 *
 * Both are bundled rather than merely transpiled so that `@brobot-client/shared`
 * — the contract the renderer also compiles against — and `ws` are inlined
 * instead of being resolved at runtime from a node_modules layout that does not
 * exist inside a packaged app.
 *
 * `--watch` additionally supervises an Electron process: every successful
 * rebuild of the main bundle restarts it. The renderer is served by `ng serve`
 * and hot-reloads itself.
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const outDir = resolve(appRoot, 'dist/electron');
const watch = process.argv.includes('--watch');

/** Resolve `@brobot-client/shared` the same way the renderer's tsconfig does. */
const sharedAlias = {
    name: 'brobot-client-shared-alias',
    setup(build) {
        build.onResolve({ filter: /^@brobot-client\/shared$/ }, () => ({
            path: resolve(appRoot, 'shared/index.ts'),
        }));
    },
};

/** @type {import('esbuild').BuildOptions} */
const common = {
    bundle: true,
    platform: 'node',
    // Electron 44 ships Node 22.
    target: 'node22',
    format: 'cjs',
    sourcemap: watch ? 'inline' : true,
    minify: !watch,
    // `electron` is provided by the runtime. `bufferutil` and
    // `utf-8-validate` are ws's optional native accelerators, required inside
    // a try/catch; leaving them external keeps ws on its pure-JS path.
    external: ['electron', 'bufferutil', 'utf-8-validate'],
    plugins: [sharedAlias],
    logLevel: 'info',
    define: {
        'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
    },
};

const targets = [
    { entry: resolve(here, 'main/main.ts'), out: resolve(outDir, 'main.js') },
    { entry: resolve(here, 'preload/preload.ts'), out: resolve(outDir, 'preload.js') },
];

let child = null;
let restarting = false;

function restartElectron() {
    if (restarting) return;
    restarting = true;
    const start = () => {
        restarting = false;
        child = spawn(process.platform === 'win32' ? 'electron.cmd' : 'electron', [appRoot], {
            stdio: 'inherit',
            env: { ...process.env, BROBOT_CLIENT_DEV_SERVER: 'http://127.0.0.1:4206' },
        });
        child.on('exit', code => {
            // An Electron the user quit (tray → Quit) stops the watcher too.
            if (!restarting && code !== null) {
                process.exit(code);
            }
        });
    };
    if (child) {
        const old = child;
        child = null;
        old.once('exit', start);
        old.kill();
    } else {
        start();
    }
}

const restartPlugin = {
    name: 'restart-electron',
    setup(build) {
        build.onEnd(result => {
            if (result.errors.length > 0) {
                console.error(`[electron] build failed with ${result.errors.length} error(s)`);
                return;
            }
            restartElectron();
        });
    },
};

if (watch) {
    const contexts = await Promise.all(
        targets.map((t, i) =>
            esbuild.context({
                ...common,
                entryPoints: [t.entry],
                outfile: t.out,
                // Only the main bundle drives the restart.
                plugins: i === 0 ? [sharedAlias, restartPlugin] : [sharedAlias],
            }),
        ),
    );
    await Promise.all(contexts.map(c => c.watch()));
    console.info('[electron] watching for changes…');
} else {
    await Promise.all(
        targets.map(t => esbuild.build({ ...common, entryPoints: [t.entry], outfile: t.out })),
    );
    console.info(`[electron] built → ${outDir}`);
}
