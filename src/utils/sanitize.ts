const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Strips characters from `name` that are illegal in filenames on Windows, macOS, or Linux.
 * - Removes: < > : " / \ | ? * and ASCII control characters (0x00–0x1F)
 * - Collapses whitespace and trims leading/trailing dots and spaces (Windows trims these silently)
 * - Renames Windows reserved device names by appending an underscore
 * - Returns an underscore if the result would otherwise be empty
 *
 * Intended for the *name* portion only — do not pass a full path, and re-append the extension yourself.
 */
export function sanitizeGameFilename(name: string): string {
  if (!name) return "_";

  let cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");

  if (!cleaned) return "_";

  const upper = cleaned.toUpperCase();
  const baseUpper = upper.split(".")[0];
  if (WINDOWS_RESERVED_NAMES.has(baseUpper)) {
    cleaned = `${cleaned}_`;
  }

  return cleaned;
}
