/** Encode each `/`-separated segment; keep the slashes (branch names, file paths). */
export const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');
