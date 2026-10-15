import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import ts from 'typescript';
import { checkFreshness } from '../../../scripts/check-library-freshness.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(app, '../..');
const pkg = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8'));
const desktop = pkg.name === '@singularity/brobot-client';
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const configs = ['tsconfig.app.json', 'tsconfig.spec.json', 'tsconfig.editor.json',
    desktop ? 'tsconfig.electron.json' : 'e2e/tsconfig.json'];
const expected = {
    '@singularity/ngx-ui': 'libs/ngx-ui/src/index.ts',
    ...(desktop ? { '@brobot-client/shared': 'apps/brobot-client/shared/index.ts' } : {
        '@singularity/contracts': 'libs/contracts/src/index.ts',
        '@singularity/contracts/angular': 'libs/contracts/generated/angular/index.ts',
        '@singularity/contracts/analytics-events': 'libs/contracts/src/analytics-events.ts',
        '@singularity/ngx-auth': 'libs/ngx-auth/src/index.ts',
    }),
};
function config(name) {
    const path = resolve(app, name);
    const data = ts.readConfigFile(path, ts.sys.readFile);
    assert.equal(data.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(data.config, ts.sys, dirname(path), undefined, path);
    assert.deepEqual(parsed.errors, []);
    return parsed;
}

test('effective configs resolve consumed libraries to source, even with stale compiled siblings', () => {
    const host = { ...ts.sys, fileExists: path => /\/(?:dist|generated)\/.*\.(?:js|d\.ts)$/.test(path) || ts.sys.fileExists(path) };
    for (const name of configs) {
        const { options } = config(name);
        for (const [specifier, source] of Object.entries(expected)) {
            if (name === 'tsconfig.electron.json' && specifier === '@singularity/ngx-ui') continue;
            const resolved = ts.resolveModuleName(specifier, resolve(app, 'resolution-consumer.ts'), options, host).resolvedModule;
            assert.equal(resolved?.resolvedFileName, resolve(root, source), `${name}: ${specifier}`);
        }
        // Check actual imports, including transitive workspace imports, rather
        // than requiring every alias available in the monorepo's base config.
        const program = ts.createProgram(config(name).fileNames, options);
        for (const file of program.getSourceFiles()) {
            if (file.isDeclarationFile || file.fileName.includes('/node_modules/')) continue;
            for (const statement of file.statements) {
                if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
                const specifier = statement.moduleSpecifier?.text;
                if (!specifier?.startsWith('@singularity/') && specifier !== '@brobot-client/shared') continue;
                const resolved = ts.resolveModuleName(specifier, file.fileName, options, host).resolvedModule;
                assert.ok(resolved && !resolved.resolvedFileName.includes('/dist/'), `${name}: ${file.fileName}: ${specifier}`);
                if (file.fileName.startsWith(app)) {
                    const dependency = specifier.match(/^@singularity\/[^/]+/)?.[0];
                    if (dependency) assert.ok(pkg.dependencies[dependency], `undeclared ${dependency}`);
                }
            }
        }
    }
});

test('consumer graph and desktop boundaries remain deliberate', () => {
    if (!desktop) return;
    assert.equal(pkg.dependencies['@singularity/contracts'], undefined);
    for (const name of configs.filter(name => name !== 'tsconfig.electron.json')) {
        assert.deepEqual(Object.keys(config(name).options.paths).sort(),
            (name === 'tsconfig.spec.json'
                ? ['@brobot-client/shared', '@singularity/ngx-ui']
                : ['@brobot-client/shared', '@singularity/ngx-ui', '@singularity/ngx-ui/styles']).sort());
    }
    const electron = config('tsconfig.electron.json');
    assert.deepEqual(Object.keys(electron.options.paths), ['@brobot-client/shared']);
    assert.ok(electron.fileNames.every(path => !path.includes('/renderer/')));
    assert.deepEqual(electron.options.lib, ['lib.es2023.d.ts']);
    assert.equal(pkg.main, 'dist/electron/main.js');
    assert.equal(pkg.scripts['build:electron'], 'node electron/esbuild.mjs');
});

test('Turbo orders the declared library builds and retains application output layouts', () => {
    const result = spawnSync(resolve(root, 'node_modules/.bin/turbo'),
        ['run', 'build', `--filter=${pkg.name}`, '--dry=json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const tasks = JSON.parse(result.stdout).tasks;
    const build = tasks.find(task => task.taskId === `${pkg.name}#build`);
    assert.ok(build.dependencies.includes('@singularity/ngx-ui#build'));
    if (desktop) {
        assert.ok(!tasks.some(task => task.package === '@singularity/contracts'));
    } else {
        for (const dependency of ['contracts', 'ngx-auth']) {
            assert.ok(build.dependencies.includes(`@singularity/${dependency}#build`));
        }
    }
    assert.ok(build.outputs.includes('dist/**'));
    const angular = JSON.parse(readFileSync(resolve(app, 'angular.json'), 'utf8'));
    const output = Object.values(angular.projects)[0].architect.build.options.outputPath;
    assert.deepEqual(output, desktop ? { base: 'dist/renderer', browser: '' } : 'dist');
});

test('direct entry points reject stale compiled output before invoking builders or tests', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'brobot-resolution-'));
    const write = (path, content) => {
        const file = resolve(fixture, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
        return file;
    };
    try {
        const consumer = `apps/${desktop ? 'brobot-client' : 'brobot-admin-ui'}`;
        write(`${consumer}/package.json`, pkg);
        for (const name of configs) {
            write(`${consumer}/${name}`, { compilerOptions: {
                baseUrl: '../..', paths: { '@singularity/ngx-ui': ['libs/ngx-ui/src/index.ts'] },
            } });
        }
        write('libs/ngx-ui/package.json', { name: '@singularity/ngx-ui', exports: { '.': './src/index.ts' } });
        write('libs/ngx-ui/ng-package.json', { dest: '../../dist/libs/ngx-ui' });
        write('libs/ngx-ui/src/index.ts', 'export const value = 2;');
        assert.deepEqual(checkFreshness({ root: fixture, consumer, tsconfig: 'tsconfig.app.json' }), [], 'source consumption needs no compiled output');
        const output = write('dist/libs/ngx-ui/fesm2022/singularity-ngx-ui.mjs', 'export const value = 1;');
        write('dist/libs/ngx-ui/package.json', { exports: { '.': './fesm2022/singularity-ngx-ui.mjs' } });
        utimesSync(output, new Date(0), new Date(0));
        for (const operation of [...(desktop ? ['build', 'build:renderer'] : ['build']), 'typecheck', 'test']) {
            const command = pkg.scripts[operation];
            assert.ok(command.startsWith(`node ../../scripts/check-library-freshness.mjs --consumer ${consumer} --tsconfig `));
            // Run the real command in an isolated workspace; the stale guard
            // must stop it before any compiler, unit runner or builder starts.
            const probe = command.replace('../../scripts/check-library-freshness.mjs',
                `${shellQuote(resolve(root, 'scripts/check-library-freshness.mjs'))} --root ${shellQuote(fixture)}`);
            const result = spawnSync(probe, { shell: true, cwd: resolve(fixture, consumer), encoding: 'utf8' });
            assert.equal(result.status, 1, result.stdout + result.stderr);
            assert.match(result.stderr, /stale compiled output/);
            assert.match(result.stderr, /pnpm exec turbo run build --filter=@singularity\/ngx-ui --force/);
        }
        if (!desktop) {
            rmSync(resolve(fixture, 'dist'), { recursive: true });
            write('libs/contracts/package.json', { name: '@singularity/contracts' });
            const diagnostics = checkFreshness({ root: fixture, consumer, tsconfig: 'tsconfig.app.json' });
            assert.ok(diagnostics.some(item => item.kind === 'generated' && item.command === 'pnpm run generate:contracts'));
        }
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});
