/**
 * Turns a low-level fs error into a message that explains the likely cause.
 * The common one on macOS: the user picks a .cue in the file dialog (granting
 * access to that file only), but the app is then denied access to the sibling
 * .bin it references — surfacing as EPERM/EACCES.
 */
export function describeFileAccessError(err: any, fallbackPath?: string): string {
  const code = err?.code;
  const target = err?.path ?? fallbackPath ?? "the file";

  if (code === "EPERM" || code === "EACCES") {
    const base = `The system blocked access to "${target}" (${code}).`;
    if (process.platform === "darwin") {
      return (
        `${base} macOS lets the app read the .cue you selected but not the .bin next to it. ` +
        `Move the game files into a normal folder inside your home directory (not Desktop, Documents, ` +
        `Downloads, iCloud Drive, or an external drive), or grant the app Full Disk Access under ` +
        `System Settings → Privacy & Security, then try again.`
      );
    }
    return `${base} Check that the file is readable and not in a restricted location, then try again.`;
  }

  if (code === "ENOENT") {
    return (
      `Could not find "${target}". The .cue references a .bin that isn't beside it — ` +
      `make sure every .bin track sits in the same folder as the .cue.`
    );
  }

  return err?.message || String(err);
}
