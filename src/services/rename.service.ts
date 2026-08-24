import * as fs from "fs/promises";
import path from "path";
import { createLogger } from "../logger";
import { sanitizeGameFilename } from "../utils/sanitize";
import { findPopstarterElf } from "./ps1-import.service";

const log = createLogger("rename");

// ── PS1 rename progress percentages ──────────────────────────────
const PROGRESS_APPS_WAIT = 10;
const PROGRESS_VCD_RENAME = 15;
const PROGRESS_POPS_SUBFOLDER = 25;
const PROGRESS_READ_APPS = 35;
const PROGRESS_ELF_RENAME = 40;
const PROGRESS_APPS_RENAME = 50;
const PROGRESS_CFG_WRITE = 70;
const PROGRESS_DONE = 100;

// ── PS1 rename retry timing (ms) ─────────────────────────────────
const RENAME_STEP2_RETRY_MAX = 10;
const RENAME_STEP2_RETRY_DELAY_MS = 500;
const RENAME_ELF_RETRY_MAX = 5;
const RENAME_ELF_RETRY_DELAY_MS = 300;
const TITLE_CFG_POST_WRITE_DELAY_MS = 800;

function deriveOldTitle(vcdPath: string, gameId: string): string | null {
  const vcdBasename = path.basename(vcdPath);
  const vcdExt = path.extname(vcdBasename);
  const vcdStem = vcdBasename.slice(0, -vcdExt.length);
  const prefix = `${gameId}.`;
  const oldTitle = vcdStem.startsWith(prefix) ? vcdStem.slice(prefix.length) : vcdStem;
  return oldTitle || null;
}

async function renameVcdFile(
  vcdPath: string,
  newVcdPath: string,
  vcdBasename: string,
  newVcdBasename: string,
  onProgress?: (percent: number, stage: string) => void,
): Promise<string | null> {
  onProgress?.(PROGRESS_VCD_RENAME, `Renaming VCD: ${vcdBasename} → ${newVcdBasename}`);
  log.info(`Renaming VCD: ${vcdBasename} → ${newVcdBasename}`);
  try {
    await fs.rename(vcdPath, newVcdPath);
    log.info(`VCD renamed: ${vcdBasename} → ${newVcdBasename}`);
    return null;
  } catch (err: unknown) {
    const msg = `Failed to rename VCD: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return msg;
  }
}

/**
 * Renames every cover-art file in ART/ that belongs to this game (per
 * `matches`, tested against the filename portion before its `_TYPE` suffix)
 * to `<newBaseName>_TYPE.ext`, preserving each file's type suffix.
 */
async function renameMatchingCoverArt(
  artDir: string,
  matches: (nameBeforeType: string) => boolean,
  newBaseName: string,
  onProgress?: (percent: number, stage: string) => void,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(artDir);
  } catch {
    return 0;
  }

  let renamed = 0;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const ext = path.extname(name);
    if (!/^\.(png|jpe?g)$/i.test(ext)) continue;
    const baseName = name.slice(0, -ext.length);
    const lastUnderscore = baseName.lastIndexOf("_");
    if (lastUnderscore < 0) continue;
    const nameBeforeType = baseName.slice(0, lastUnderscore);
    const type = baseName.slice(lastUnderscore + 1);
    if (!matches(nameBeforeType)) continue;

    const newName = `${newBaseName}_${type}${ext}`;
    if (newName === name) continue;
    try {
      await fs.rename(path.join(artDir, name), path.join(artDir, newName));
      log.verbose(`Renamed artwork: ${name} → ${newName}`);
      renamed++;
    } catch (err: unknown) {
      log.warn(
        `Failed to rename artwork ${name} → ${newName}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (renamed > 0) {
    onProgress?.(90, `Renamed ${renamed} artwork file(s): *_TYPE → ${newBaseName}_TYPE`);
    log.info(`Renamed ${renamed} artwork file(s) in ${artDir} to "${newBaseName}_*"`);
  }
  return renamed;
}

async function renamePopsSubfolder(
  popsDir: string,
  oldTitle: string,
  safeNewTitle: string,
  onProgress?: (percent: number, stage: string) => void,
): Promise<void> {
  onProgress?.(PROGRESS_POPS_SUBFOLDER, `Renaming VMC folder: ${oldTitle}/ → ${safeNewTitle}/`);
  log.info(`Renaming VMC folder: ${oldTitle}/ → ${safeNewTitle}/`);
  try {
    await fs.access(path.join(popsDir, oldTitle));
    await fs.rename(path.join(popsDir, oldTitle), path.join(popsDir, safeNewTitle));
    log.verbose(`POPS VMC subfolder renamed`);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.verbose(`POPS VMC subfolder does not exist — skipping`);
    } else {
      log.warn(`Failed to rename POPS VMC subfolder: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface AppsFolderContents {
  oldElfFile?: string;
  oldTitleCfgContent: string;
}

async function readAppsFolderContents(oldAppsFolder: string): Promise<AppsFolderContents | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const files = await fs.readdir(oldAppsFolder);
      const oldElfFile = files.find((f) => /\.ELF$/i.test(f));
      let oldTitleCfgContent = "";
      try {
        oldTitleCfgContent = await fs.readFile(path.join(oldAppsFolder, "title.cfg"), "utf-8");
      } catch { /* no title.cfg — fine */ }
      return { oldElfFile, oldTitleCfgContent };
    } catch {
      if (attempt < 4) await new Promise((r) => setTimeout(r, 200));
    }
  }
  return null;
}

function computeNewElfName(
  oldElfFile: string | undefined,
  gameId: string,
  oldTitle: string,
  safeNewTitle: string,
): string | undefined {
  if (!oldElfFile || !/\.ELF$/i.test(oldElfFile)) return undefined;

  const elfExt = path.extname(oldElfFile);
  const elfStem = oldElfFile.slice(0, -elfExt.length);
  const gIdx = elfStem.indexOf(gameId);
  if (gIdx !== -1) {
    return `${elfStem.slice(0, gIdx)}${gameId}.${safeNewTitle}${elfExt}`;
  }

  const tIdx = elfStem.lastIndexOf(oldTitle);
  if (tIdx !== -1) {
    const newName = `${elfStem.slice(0, tIdx)}${safeNewTitle}${elfExt}`;
    log.verbose(`ELF name derived via oldTitle fallback: ${oldElfFile} → ${newName}`);
    return newName;
  }

  log.warn(`ELF name lacks gameId "${gameId}" and oldTitle "${oldTitle}" — keeping existing`);
  return oldElfFile;
}

interface CfgBuildResult {
  content: string;
  bootVal?: string;
}

function buildNewCfgContent(
  oldTitleCfgContent: string,
  newTitle: string,
  newElfFile: string | undefined,
  gameId: string,
): CfgBuildResult {
  const bootVal = newElfFile ? `boot=${newElfFile}` : undefined;
  const seenKeys = new Map<string, string>();

  const cfgLines = oldTitleCfgContent.split("\n").map((line) => {
    const t = line.trimEnd();
    const eq = t.indexOf("=");
    if (eq === -1) return line;
    const k = t.slice(0, eq).trim();
    const lower = k.toLowerCase();
    if (!seenKeys.has(lower)) seenKeys.set(lower, k);
    if (lower === "title") {
      return k === "Title" ? `Title=${newTitle}` : `title=${newTitle}`;
    }
    if (lower === "boot" && bootVal) return bootVal;
    return line;
  });

  const add: string[] = [];
  if (!seenKeys.has("title")) { add.push(`title=${newTitle}`); add.push(`Title=${newTitle}`); }
  if (!seenKeys.has("boot") && bootVal) add.push(bootVal);
  if (!seenKeys.has("gameid")) add.push(`GameID=${gameId}`);

  const content =
    add.length > 0
      ? cfgLines.join("\n") + (cfgLines.length && cfgLines[cfgLines.length - 1] !== "" ? "\n" : "") + add.join("\n") + "\n"
      : cfgLines.join("\n");

  return { content, bootVal };
}

export async function renamePs1LauncherStep1(
  vcdPath: string,
  gameId: string,
  newTitle: string,
  onProgress?: (percent: number, stage: string) => void
): Promise<{
  success: boolean;
  newVcdPath?: string;
  oldElfFile?: string;
  newElfFile?: string;
  newCfgContent?: string;
  newAppsFolder?: string;
  safeNewTitle?: string;
  message?: string;
}> {
  const safeNewTitle = sanitizeGameFilename(newTitle);
  if (!safeNewTitle) {
    return { success: false, message: "The new name is empty or invalid after sanitization." };
  }

  const popsDir = path.dirname(vcdPath);
  const oplRoot = path.resolve(popsDir, "..");

  const oldTitle = deriveOldTitle(vcdPath, gameId);
  if (!oldTitle) {
    return { success: false, message: "Could not derive the current game title from the VCD filename." };
  }
  if (oldTitle === safeNewTitle) {
    return { success: false, message: "The new name is identical to the current name." };
  }

  log.info(`PS1 rename step 1: "${oldTitle}" → "${safeNewTitle}" (gameId=${gameId})`);

  const vcdBasename = path.basename(vcdPath);
  const vcdExt = path.extname(vcdBasename);
  const newVcdBasename = `${safeNewTitle}${vcdExt}`;
  const newVcdPath = path.join(popsDir, newVcdBasename);
  const appsDir = path.join(oplRoot, "APPS");
  const oldAppsFolder = path.join(appsDir, `POPS_${oldTitle}`);
  const newAppsFolder = path.join(appsDir, `POPS_${safeNewTitle}`);

  const vcdError = await renameVcdFile(vcdPath, newVcdPath, vcdBasename, newVcdBasename, onProgress);
  if (vcdError) return { success: false, message: vcdError };

  await renamePopsSubfolder(popsDir, oldTitle, safeNewTitle, onProgress);

  onProgress?.(PROGRESS_READ_APPS, "Reading APPS launcher folder contents…");
  const appsContents = await readAppsFolderContents(oldAppsFolder);
  if (!appsContents) {
    return { success: false, message: `Cannot read APPS folder "${oldAppsFolder}".` };
  }

  const newElfFile = computeNewElfName(appsContents.oldElfFile, gameId, oldTitle, safeNewTitle);

  const { content: newCfgContent } = buildNewCfgContent(
    appsContents.oldTitleCfgContent,
    newTitle,
    newElfFile,
    gameId,
  );

  onProgress?.(PROGRESS_APPS_RENAME, `Renaming APPS folder: POPS_${oldTitle}/ → POPS_${safeNewTitle}/`);
  log.info(`Renaming APPS folder: POPS_${oldTitle}/ → POPS_${safeNewTitle}/`);
  try {
    await fs.rename(oldAppsFolder, newAppsFolder);
    log.info(`APPS folder renamed: POPS_${oldTitle}/ → POPS_${safeNewTitle}/`);
  } catch (err: unknown) {
    const msg = `Failed to rename APPS launcher folder: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return { success: false, message: msg };
  }

  log.info(`PS1 rename step 1 complete for "${oldTitle}" → "${safeNewTitle}"`);
  return {
    success: true,
    newVcdPath,
    oldElfFile: appsContents.oldElfFile,
    newElfFile,
    newCfgContent,
    newAppsFolder,
    safeNewTitle,
  };
}

export async function renamePs1LauncherStep2(
  params: {
    newAppsFolder: string;
    oldElfFile?: string;
    newElfFile?: string;
    newCfgContent?: string;
    newTitle: string;
  },
  onProgress?: (percent: number, stage: string) => void
): Promise<{
  success: boolean;
  message?: string;
}> {
  const { newAppsFolder, oldElfFile, newElfFile, newCfgContent, newTitle } = params;

  log.info(`PS1 rename step 2: applying internal changes to ${newAppsFolder}`);

  onProgress?.(PROGRESS_APPS_WAIT, "Waiting for APPS folder to be ready…");
  await new Promise((r) => setTimeout(r, TITLE_CFG_POST_WRITE_DELAY_MS));

  let appsReady = false;
  for (let attempt = 0; attempt < RENAME_STEP2_RETRY_MAX; attempt++) {
    try {
      await fs.access(newAppsFolder, fs.constants.F_OK);
      const files = await fs.readdir(newAppsFolder);
      if (oldElfFile && !files.some((f) => /\.ELF$/i.test(f))) {
        throw new Error("ELF not yet visible");
      }
      appsReady = true;
      break;
    } catch {
      if (attempt < RENAME_STEP2_RETRY_MAX - 1) await new Promise((r) => setTimeout(r, RENAME_STEP2_RETRY_DELAY_MS));
    }
  }
  if (!appsReady) {
    return { success: false, message: `APPS folder "${newAppsFolder}" is not ready.` };
  }

  if (oldElfFile && newElfFile && oldElfFile !== newElfFile) {
    onProgress?.(PROGRESS_ELF_RENAME, `Renaming ELF: ${oldElfFile} → ${newElfFile}`);
    log.info(`Renaming ELF: ${oldElfFile} → ${newElfFile}`);
    const oldPath = path.join(newAppsFolder, oldElfFile);
    const newPath = path.join(newAppsFolder, newElfFile);
    let done = false;
    for (let attempt = 0; attempt < RENAME_ELF_RETRY_MAX; attempt++) {
      try {
        await fs.rename(oldPath, newPath);
        await fs.access(newPath, fs.constants.F_OK);
        done = true;
        break;
      } catch {
        if (attempt < RENAME_ELF_RETRY_MAX - 1) await new Promise((r) => setTimeout(r, RENAME_ELF_RETRY_DELAY_MS));
      }
    }
    if (!done) {
      log.error(`ELF rename failed after retries: ${oldElfFile} → ${newElfFile}`);
      return { success: false, message: `Failed to rename ELF after multiple attempts.` };
    }
    log.info(`ELF renamed: ${oldElfFile} → ${newElfFile}`);
  }

  if (newCfgContent !== undefined) {
    onProgress?.(PROGRESS_CFG_WRITE, "Updating title.cfg (title, Title, boot)");
    log.info("Updating title.cfg (title, Title, boot)");
    const cfgPath = path.join(newAppsFolder, "title.cfg");
    let done = false;
    for (let attempt = 0; attempt < RENAME_ELF_RETRY_MAX; attempt++) {
      try {
        await fs.writeFile(cfgPath, newCfgContent, "utf-8");
        const verify = await fs.readFile(cfgPath, "utf-8");
        if (verify === newCfgContent) {
          done = true;
          break;
        }
      } catch {
        if (attempt < RENAME_ELF_RETRY_MAX - 1) await new Promise((r) => setTimeout(r, RENAME_ELF_RETRY_DELAY_MS));
      }
    }
    if (!done) {
      log.error(`title.cfg write failed after retries`);
      return { success: false, message: `Failed to update title.cfg after multiple attempts.` };
    }
    log.info(`title.cfg updated`);
  }

  onProgress?.(PROGRESS_DONE, "Rename complete");
  log.info(`PS1 rename step 2 complete`);
  return { success: true };
}

/**
 * Converts a POPStarter-launched PS1 game to POPSLoader style: strips the
 * "<GameID>." prefix from the VCD filename, deletes the APPS launcher
 * folder, and renames any matching ART/ files (previously keyed by GameID
 * or the launcher's ELF filename) to the "<Title>_TYPE.png" convention
 * POPSLoader/RiptOPL expects.
 */
export async function convertPs1LauncherToPopsLoader(
  vcdPath: string,
  gameId: string,
  onProgress?: (percent: number, stage: string) => void,
): Promise<{
  success: boolean;
  newVcdPath?: string;
  message?: string;
}> {
  const popsDir = path.dirname(vcdPath);
  const oplRoot = path.resolve(popsDir, "..");

  const oldTitle = deriveOldTitle(vcdPath, gameId);
  if (!oldTitle) {
    return { success: false, message: "Could not derive the current game title from the VCD filename." };
  }

  const vcdBasename = path.basename(vcdPath);
  const vcdExt = path.extname(vcdBasename);
  if (vcdBasename === `${oldTitle}${vcdExt}`) {
    return { success: false, message: "This game's VCD filename already has no GameID prefix." };
  }

  log.info(`PS1 convert-to-POPSLoader: "${vcdBasename}" (gameId=${gameId})`);

  const newVcdBasename = `${oldTitle}${vcdExt}`;
  const newVcdPath = path.join(popsDir, newVcdBasename);

  const vcdError = await renameVcdFile(vcdPath, newVcdPath, vcdBasename, newVcdBasename, onProgress);
  if (vcdError) return { success: false, message: vcdError };

  const appsFolder = path.join(oplRoot, "APPS", `POPS_${oldTitle}`);
  onProgress?.(80, `Removing APPS launcher: POPS_${oldTitle}/`);
  try {
    await fs.rm(appsFolder, { recursive: true, force: true });
    log.info(`Removed APPS launcher folder: POPS_${oldTitle}/`);
  } catch (err: unknown) {
    const msg = `VCD renamed, but failed to remove APPS launcher folder: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return { success: false, newVcdPath, message: msg };
  }

  onProgress?.(88, "Renaming cover art to match the new filename…");
  const gameIdUpper = gameId.toUpperCase();
  await renameMatchingCoverArt(
    path.join(oplRoot, "ART"),
    (nameBeforeType) => nameBeforeType.toUpperCase().includes(gameIdUpper),
    oldTitle,
    onProgress,
  );

  onProgress?.(PROGRESS_DONE, "Conversion complete");
  log.info(`PS1 convert-to-POPSLoader complete: "${vcdBasename}" → "${newVcdBasename}"`);
  return { success: true, newVcdPath };
}

/**
 * Reverses `convertPs1LauncherToPopsLoader`: prefixes the VCD filename with
 * "<GameID>.", recreates the APPS/POPStarter launcher (POPSTARTER.ELF +
 * title.cfg), and renames any matching ART/ files from the "<Title>_TYPE.png"
 * convention to the "<ELF filename>_TYPE.png" convention POPStarter expects.
 */
export async function convertPs1LauncherToPopstarter(
  vcdPath: string,
  gameId: string,
  gameName: string,
  elfPrefix: string,
  onProgress?: (percent: number, stage: string) => void,
): Promise<{
  success: boolean;
  newVcdPath?: string;
  message?: string;
}> {
  const popsDir = path.dirname(vcdPath);
  const oplRoot = path.resolve(popsDir, "..");

  const vcdBasename = path.basename(vcdPath);
  const vcdExt = path.extname(vcdBasename);
  const title = vcdBasename.slice(0, -vcdExt.length);
  const safeTitle = sanitizeGameFilename(title) || title;

  if (title.toLowerCase().startsWith(`${gameId.toLowerCase()}.`)) {
    return { success: false, message: "This game's VCD filename already has a GameID prefix." };
  }

  log.info(`PS1 convert-to-POPStarter: "${vcdBasename}" (gameId=${gameId})`);

  onProgress?.(0, "Setting up POPStarter launcher");
  const popstarterElf = await findPopstarterElf();
  if (!popstarterElf) {
    return {
      success: false,
      message:
        "POPSTARTER.ELF not found in assets. Please place the Popstarter ELF file at assets/POPSTARTER.ELF.",
    };
  }

  const newVcdBasename = `${gameId}.${safeTitle}${vcdExt}`;
  const newVcdPath = path.join(popsDir, newVcdBasename);

  const vcdError = await renameVcdFile(vcdPath, newVcdPath, vcdBasename, newVcdBasename, onProgress);
  if (vcdError) return { success: false, message: vcdError };

  const elfFilename = elfPrefix
    ? `${elfPrefix}${gameId}.${safeTitle}.ELF`
    : `${gameId}.${safeTitle}.ELF`;
  const appsFolderName = `POPS_${safeTitle}`;
  const appsGameDir = path.join(oplRoot, "APPS", appsFolderName);

  onProgress?.(50, `Creating APPS launcher: ${appsFolderName}/`);
  try {
    await fs.mkdir(appsGameDir, { recursive: true });
    await fs.copyFile(popstarterElf, path.join(appsGameDir, elfFilename));
    await fs.writeFile(
      path.join(appsGameDir, "title.cfg"),
      `title=${gameName}\nboot=${elfFilename}\nGameID=${gameId}\n`,
      "utf-8"
    );
    log.info(`Created POPStarter launcher APPS/${appsFolderName}/${elfFilename}`);
  } catch (err: unknown) {
    const msg = `VCD renamed, but failed to create APPS launcher: ${err instanceof Error ? err.message : String(err)}`;
    log.error(msg);
    return { success: false, newVcdPath, message: msg };
  }

  onProgress?.(88, "Renaming cover art to match the new launcher…");
  const safeTitleLower = safeTitle.toLowerCase();
  await renameMatchingCoverArt(
    path.join(oplRoot, "ART"),
    (nameBeforeType) => nameBeforeType.toLowerCase() === safeTitleLower,
    elfFilename,
    onProgress,
  );

  onProgress?.(PROGRESS_DONE, "Conversion complete");
  log.info(`PS1 convert-to-POPStarter complete: "${vcdBasename}" → "${newVcdBasename}"`);
  return { success: true, newVcdPath };
}
