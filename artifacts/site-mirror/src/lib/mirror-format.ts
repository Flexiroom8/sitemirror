export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export const MIRROR_PREFILL_KEY = 'site-mirror:prefill';

export function saveMirrorPrefill(value: Record<string, unknown>): void {
  try {
    window.localStorage.setItem(MIRROR_PREFILL_KEY, JSON.stringify(value));
  } catch {
    // Local storage is optional; the next screen still remains usable.
  }
}

export function readMirrorPrefill<T>(): T | null {
  try {
    const value = window.localStorage.getItem(MIRROR_PREFILL_KEY);
    if (!value) return null;
    window.localStorage.removeItem(MIRROR_PREFILL_KEY);
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
