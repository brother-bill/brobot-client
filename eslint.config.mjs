import { createAngularConfig } from '../../eslint.angular-base.config.mjs';
import a11yConfig from '../../eslint.angular-a11y.config.mjs';

export default createAngularConfig({
    prefix: 'app',
    tsconfigRootDir: import.meta.dirname,
    includeA11y: true,
    a11yConfig,
    additionalRules: [
        {
            ignores: ['dist/**', 'release/**'],
        },
        {
            // The Electron main process is Node, not a browser: it is the one
            // place in this app allowed to spawn PowerShell, touch the disk and
            // log to the terminal the app was launched from.
            files: ['electron/**/*.ts'],
            rules: {
                'no-console': 'off',
            },
        },
        {
            // The esbuild script is plain Node ESM outside every tsconfig.
            files: ['electron/esbuild.mjs'],
            languageOptions: {
                globals: {
                    process: 'readonly',
                    console: 'readonly',
                },
                parserOptions: {
                    projectService: false,
                },
            },
            rules: {
                'no-console': 'off',
                '@typescript-eslint/no-floating-promises': 'off',
                '@typescript-eslint/no-unnecessary-condition': 'off',
            },
        },
    ],
});
