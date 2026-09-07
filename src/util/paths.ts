import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Linux/XDG base directories for elv, in one place.
 *
 * `ELV_*` overrides win over XDG, which wins over the HOME defaults. A relative
 * or empty XDG value is ignored rather than resolved against the current
 * directory: XDG requires absolute paths, and silently making a cache or config
 * root cwd-relative would move state every time an agent changes directory.
 */

const APP_DIR = "elv";

export function defaultCacheDir(): string {
  const override = process.env.ELV_CACHE_DIR;
  if (override) return absolutePath(override);
  return xdgAppDir("XDG_CACHE_HOME") ?? join(homedir(), ".cache", APP_DIR);
}

export function defaultConfigDir(): string {
  return xdgAppDir("XDG_CONFIG_HOME") ?? join(homedir(), ".config", APP_DIR);
}

export function defaultDataDir(): string {
  return xdgAppDir("XDG_DATA_HOME") ?? join(homedir(), ".local", "share", APP_DIR);
}

/** The pre-XDG user config directory, still read when the XDG target is absent. */
export function legacyConfigDir(): string {
  return join(homedir(), ".config", APP_DIR);
}

export function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function xdgAppDir(variable: string): string | undefined {
  const base = process.env[variable];
  return base && isAbsolute(base) ? join(base, APP_DIR) : undefined;
}
