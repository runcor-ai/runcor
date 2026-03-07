// File watcher for runcor dev — watches config and flow files
// Uses Node.js built-in fs.watch() with 200ms debounce per research.md §3

import { watch, type FSWatcher } from 'node:fs';

export interface WatchEvent {
  type: 'config' | 'flow';
  path: string;
}

export type WatchCallback = (event: WatchEvent) => void;

/**
 * Watch files for changes with debouncing.
 * @returns Cleanup function that closes all watchers
 */
export function watchFiles(
  paths: { configPath: string; flowPaths: string[] },
  onChange: WatchCallback,
): () => void {
  const watchers: FSWatcher[] = [];
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const DEBOUNCE_MS = 200;

  function debounced(filePath: string, event: WatchEvent): void {
    const existing = debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);
    debounceTimers.set(filePath, setTimeout(() => {
      debounceTimers.delete(filePath);
      onChange(event);
    }, DEBOUNCE_MS));
  }

  // Watch config file
  try {
    const w = watch(paths.configPath, () => {
      debounced(paths.configPath, { type: 'config', path: paths.configPath });
    });
    watchers.push(w);
  } catch {
    // Config file watch failed — not critical
  }

  // Watch flow files
  for (const flowPath of paths.flowPaths) {
    try {
      const w = watch(flowPath, () => {
        debounced(flowPath, { type: 'flow', path: flowPath });
      });
      watchers.push(w);
    } catch {
      // Flow file watch failed — skip
    }
  }

  return () => {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers.length = 0;
  };
}
