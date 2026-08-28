import AdmZip from "adm-zip";
import * as fs from "fs/promises";
import * as os from "os";
import path from "path";
import { createLogger } from "../logger";

const log = createLogger("zip-extract");

export interface ExtractedDiscZip {
  tempDir: string;
  cuePath: string | null;
  binPath: string | null;
}

async function findFirstByExt(dir: string, ext: string): Promise<string | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const subdirs: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "__MACOSX") continue;
      subdirs.push(path.join(dir, entry.name));
      continue;
    }
    if (path.extname(entry.name).toLowerCase() === ext) {
      return path.join(dir, entry.name);
    }
  }

  for (const subdir of subdirs) {
    const found = await findFirstByExt(subdir, ext);
    if (found) return found;
  }
  return null;
}

/**
 * Extracts a ZIP archive (expected to contain a PS1 disc's .cue + .bin
 * pair) to a fresh temp directory and locates the .cue/.bin inside,
 * wherever they sit in the archive's folder structure. Caller owns the
 * returned tempDir and must remove it once done (see cleanupExtractedZip).
 */
export async function extractDiscZip(zipFilePath: string): Promise<ExtractedDiscZip> {
  const tempDir = path.join(
    os.tmpdir(),
    `orbitps2-zip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  await fs.mkdir(tempDir, { recursive: true });

  log.verbose(`Extracting ${path.basename(zipFilePath)} → ${tempDir}`);
  const zip = new AdmZip(zipFilePath);
  zip.extractAllTo(tempDir, true);

  const cuePath = await findFirstByExt(tempDir, ".cue");
  const binPath = await findFirstByExt(tempDir, ".bin");
  log.verbose(
    `Extracted ${path.basename(zipFilePath)}: cue=${cuePath ? path.basename(cuePath) : "none"}, bin=${binPath ? path.basename(binPath) : "none"}`
  );

  return { tempDir, cuePath, binPath };
}

export async function cleanupExtractedZip(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (err: any) {
    log.warn(`Failed to clean up extracted ZIP temp dir ${tempDir}:`, err?.message || err);
  }
}
