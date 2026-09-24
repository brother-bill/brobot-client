import type { ApplicationConfig } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideLibUi } from '@singularity/ngx-ui';
import { provideHostBridge } from './core/host-bridge';

export const appConfig: ApplicationConfig = {
    providers: [
        provideZonelessChangeDetection(),
        provideHostBridge(),
        provideLibUi({
            button: { defaultVariant: 'secondary' },
        }),
    ],
};
