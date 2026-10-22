/**
 * Updates: what the main process knows about a newer brobot, and what the
 * window and the tray show about it.
 *
 * Releases are GitHub Releases on brother-bill/brobot-client (public, so the
 * app needs no token to read them). The app looks on its own; it never
 * downloads or installs anything until the streamer clicks Install.
 */

/** Where a streamer can download a release by hand. */
export const RELEASES_URL = 'https://github.com/brother-bill/brobot-client/releases/latest';

/**
 * - `unsupported` — this copy cannot update itself (development, the portable
 *   exe, not Windows); `unsupportedReason` says which.
 * - `idle`        — up to date as of `lastCheckedAt`, or not checked yet.
 * - `checking`    — asking GitHub.
 * - `available`   — `update` is newer than this copy.
 * - `downloading` — fetching `update`; `percent` moves.
 * - `installing`  — downloaded; brobot is quitting to run the installer.
 * - `error`       — the download or the installer failed (`lastError`; Install
 *   retries), or a check failed before any release was found. A check that
 *   fails once a release is known leaves it `available`, with `lastError`.
 */
export type UpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'error';

export interface UpdateRelease {
    readonly version: string;
    /** The release's notes as written on GitHub (Markdown, shown as text). Empty when it has none. */
    readonly notes: string;
}

export interface UpdateStatus {
    readonly phase: UpdatePhase;
    readonly currentVersion: string;
    readonly unsupportedReason: string | null;
    /** The newer release, once one is known. */
    readonly update: UpdateRelease | null;
    /** 0–100, while `downloading`. */
    readonly percent: number;
    /** Epoch ms of the last check that finished, either way. */
    readonly lastCheckedAt: number | null;
    readonly lastError: string | null;
    /** "Later" was clicked for `update`: the window stops offering it until a newer one appears. */
    readonly dismissed: boolean;
}

/** The first look happens a minute after start, so it never competes with connecting. */
export const UPDATE_FIRST_CHECK_DELAY_MS = 60_000;

/** Then every four hours: a long stream still hears about a fix the same evening. */
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
