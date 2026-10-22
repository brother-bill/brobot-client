#!/usr/bin/env node
/**
 * Writes release/brobot-update.json beside the installer electron-builder just
 * built: the version, the installer's file name, its size and its SHA-512
 * (base64). The installed app reads it from the GitHub Release
 * (electron/main/core/release.ts) and refuses a download that does not match,
 * so the hash is taken here, from the file the build produced.
 *
 * Run by `dist` and `dist:linux` after electron-builder.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(app, 'package.json'), 'utf8'));
const file = `brobot-setup-${version}.exe`;
const installer = resolve(app, 'release', file);

const bytes = readFileSync(installer);
const manifest = {
    version,
    installer: {
        file,
        size: statSync(installer).size,
        sha512: createHash('sha512').update(bytes).digest('base64'),
    },
};
writeFileSync(resolve(app, 'release', 'brobot-update.json'), `${JSON.stringify(manifest, null, 4)}\n`);
stdout.write(`release-manifest: ${file}, ${manifest.installer.size} bytes\n`);
