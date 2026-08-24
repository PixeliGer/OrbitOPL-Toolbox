import { app } from "electron";
import path from "path";

/**
 * Path to the bundled "assets" directory, both in dev (project root) and
 * packaged builds (inside app.asar, next to package.json). __dirname-relative
 * lookups break whenever a module moves to a different folder depth under
 * src/, so this is the source of truth — candidate lists that also try
 * __dirname-relative paths are just a safety net for unusual layouts.
 */
export function getAssetsDir(): string {
  return path.join(app.getAppPath(), "assets");
}
