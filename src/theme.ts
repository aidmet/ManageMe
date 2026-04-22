export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'manageme_theme';

let systemMql: MediaQueryList | null = null;
let systemListener: (() => void) | null = null;

function applyDataThemeFromPreference(pref: ThemePreference): void {
    const root = document.documentElement;
    if (pref === 'light') {
        root.setAttribute('data-theme', 'light');
    } else if (pref === 'dark') {
        root.setAttribute('data-theme', 'dark');
    } else {
        root.removeAttribute('data-theme');
    }
}

export function getTheme(): ThemePreference {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === 'light' || raw === 'dark' || raw === 'system') {
            return raw;
        }
    } catch {
        /* ignore */
    }
    return 'system';
}

/** True when the UI should use dark palette (explicit dark or system+OS dark). */
export function isEffectiveDarkTheme(): boolean {
    const pref = getTheme();
    if (pref === 'dark') {
        return true;
    }
    if (pref === 'light') {
        return false;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function notifyWindowBackground(): void {
    const hex = isEffectiveDarkTheme() ? '#0f172a' : '#e8eef9';
    window.manageMeDesktop?.setWindowBackgroundColor?.(hex);
}

function attachSystemListener(attach: boolean): void {
    if (systemMql && systemListener) {
        systemMql.removeEventListener('change', systemListener);
        systemMql = null;
        systemListener = null;
    }
    if (attach && typeof window.matchMedia === 'function') {
        systemMql = window.matchMedia('(prefers-color-scheme: dark)');
        systemListener = () => {
            if (getTheme() === 'system') {
                notifyWindowBackground();
            }
        };
        systemMql.addEventListener('change', systemListener);
    }
}

export function setTheme(pref: ThemePreference): void {
    try {
        localStorage.setItem(STORAGE_KEY, pref);
    } catch {
        /* ignore */
    }
    applyDataThemeFromPreference(pref);
    attachSystemListener(pref === 'system');
    notifyWindowBackground();
}

export function cycleTheme(): ThemePreference {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    const cur = getTheme();
    const i = order.indexOf(cur);
    const next = order[(i + 1) % order.length];
    setTheme(next);
    return next;
}

export function initThemeFromStorage(): void {
    applyDataThemeFromPreference(getTheme());
    attachSystemListener(getTheme() === 'system');
    notifyWindowBackground();
}

export function themePreferenceLabel(pref: ThemePreference): string {
    if (pref === 'light') {
        return 'Light';
    }
    if (pref === 'dark') {
        return 'Dark';
    }
    return 'System';
}

