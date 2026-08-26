import * as fs from "fs/promises";
import * as fsSync from "fs";
import path from "path";
import {
  parseCueSheet,
  msfToSectors,
  sectorsToMsf,
  CueSheet,
  CueTrack,
} from "./cue-parser";
import { createLogger, formatBytes } from "../logger";

const log = createLogger("cue2pops");

const SECTOR_SIZE = 2352;
const HEADER_SIZE = 1048576; // 1 MB = 0x100000
const SIGNATURE = Buffer.from([0x6b, 0x48, 0x6e, 0x20]); // "kHn "

function toBcd(value: number): number {
  return Math.floor(value / 10) * 16 + (value % 10);
}

function fromBcd(value: number): number {
  return Math.floor(value / 16) * 10 + (value % 16);
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatMsf(msf: { mm: number; ss: number; ff: number }): string {
  return `${pad2(msf.mm)}:${pad2(msf.ss)}:${pad2(msf.ff)}`;
}

function isDataTrack(track: CueTrack): boolean {
  return track.type.startsWith("MODE");
}

function trackTypeByte(track: CueTrack): number {
  return isDataTrack(track) ? 0x41 : 0x01;
}

interface MsfBcd {
  mm: number;
  ss: number;
  ff: number;
}

function addSeconds(
  mm: number,
  ss: number,
  ff: number,
  addSec: number
): { mm: number; ss: number; ff: number } {
  const totalFrames = mm * 60 * 75 + ss * 75 + ff + addSec * 75;
  return {
    mm: Math.floor(totalFrames / (60 * 75)),
    ss: Math.floor((totalFrames % (60 * 75)) / 75),
    ff: totalFrames % 75,
  };
}

function buildHeader(cueSheet: CueSheet, binSize: number): Buffer {
  const header = Buffer.alloc(HEADER_SIZE, 0);

  const allTracks: CueTrack[] = [];
  for (const file of cueSheet.files) {
    allTracks.push(...file.tracks);
  }

  const trackCount = allTracks.length;
  const firstTrack = allTracks[0];
  const lastTrack = allTracks[trackCount - 1];
  const lastTrackType = trackTypeByte(lastTrack);

  // Count pregaps and postgaps
  let pregapCount = 0;
  let postgapCount = 0;
  for (const track of allTracks) {
    if (track.pregap) pregapCount++;
    if (track.postgap) postgapCount++;
  }

  // Calculate sector count and lead-out
  const sectorCount =
    Math.floor(binSize / SECTOR_SIZE) +
    150 * (pregapCount + postgapCount);
  const leadOutSectors = sectorCount + 150;
  const leadOut = sectorsToMsf(leadOutSectors);

  // Detect CDRWIN-style CUE (exactly 1 pregap, 0 postgap)
  const isCdrwin = pregapCount === 1 && postgapCount === 0;

  // --- Descriptor A0 (bytes 0-9): Disc Type ---
  header[0] = trackTypeByte(firstTrack);
  header[1] = 0x00;
  header[2] = 0xa0;
  header[3] = 0x00;
  header[4] = 0x00;
  header[5] = 0x00;
  header[6] = 0x00;
  header[7] = 0x01; // first track number
  header[8] = 0x20; // CD-XA
  header[9] = 0x00;

  // --- Descriptor A1 (bytes 10-19): Content ---
  header[10] = lastTrackType;
  header[11] = 0x00;
  header[12] = 0xa1;
  header[13] = 0x00;
  header[14] = 0x00;
  header[15] = 0x00;
  header[16] = 0x00;
  header[17] = toBcd(trackCount);
  header[18] = 0x00;
  header[19] = 0x00;

  // --- Descriptor A2 (bytes 20-29): Lead-Out ---
  header[20] = lastTrackType;
  header[21] = 0x00;
  header[22] = 0xa2;
  header[23] = 0x00;
  header[24] = 0x00;
  header[25] = 0x00;
  header[26] = 0x00;
  header[27] = toBcd(leadOut.minutes);
  header[28] = toBcd(leadOut.seconds);
  header[29] = toBcd(leadOut.frames);

  // --- Track entries (starting at byte 30, 10 bytes each) ---
  for (let i = 0; i < allTracks.length; i++) {
    const track = allTracks[i];
    const offset = 30 + i * 10;
    const type = trackTypeByte(track);

    // Find INDEX 00 and INDEX 01
    const idx00 = track.indexes.find((idx) => idx.number === 0);
    const idx01 = track.indexes.find((idx) => idx.number === 1);

    let i00mm = idx00?.minutes ?? 0;
    let i00ss = idx00?.seconds ?? 0;
    let i00ff = idx00?.frames ?? 0;
    let i01mm = idx01?.minutes ?? 0;
    let i01ss = idx01?.seconds ?? 0;
    let i01ff = idx01?.frames ?? 0;

    // Apply +2 second adjustment
    if (i === 0) {
      // Track 1: only adjust INDEX 01
      const adj01 = addSeconds(i01mm, i01ss, i01ff, 2);
      i01mm = adj01.mm;
      i01ss = adj01.ss;
      i01ff = adj01.ff;
    } else {
      // Other tracks: adjust both INDEX 00 and INDEX 01
      const addSec = isCdrwin ? 4 : 2;
      const adj00 = addSeconds(i00mm, i00ss, i00ff, addSec);
      i00mm = adj00.mm;
      i00ss = adj00.ss;
      i00ff = adj00.ff;
      const adj01 = addSeconds(i01mm, i01ss, i01ff, addSec);
      i01mm = adj01.mm;
      i01ss = adj01.ss;
      i01ff = adj01.ff;
    }

    header[offset + 0] = type;
    header[offset + 1] = 0x00;
    header[offset + 2] = toBcd(track.number);
    header[offset + 3] = toBcd(i00mm);
    header[offset + 4] = toBcd(i00ss);
    header[offset + 5] = toBcd(i00ff);
    header[offset + 6] = 0x00;
    header[offset + 7] = toBcd(i01mm);
    header[offset + 8] = toBcd(i01ss);
    header[offset + 9] = toBcd(i01ff);
  }

  // --- Signature at byte 1024 ---
  SIGNATURE.copy(header, 1024);

  // --- Sector count at bytes 1032 and 1036 (LE uint32) ---
  header.writeUInt32LE(sectorCount, 1032);
  header.writeUInt32LE(sectorCount, 1036);

  return header;
}

export async function convertToVcd(
  binPath: string,
  cuePath: string,
  outputVcdPath: string,
  onProgress?: (percent: number, stage: string) => void
): Promise<void> {
  const cueSheet = await parseCueSheet(cuePath);

  // Verify single-file CUE
  if (cueSheet.files.length !== 1) {
    throw new Error(
      "CUE must reference a single BIN file. Use binmerge first for multi-BIN CUEs."
    );
  }

  const binStat = await fs.stat(binPath);
  const binSize = binStat.size;
  log.info(`Converting BIN→VCD: ${formatBytes(binSize)} → ${outputVcdPath}`);

  if (onProgress) onProgress(5, "Building VCD header");

  // Build header
  const header = buildHeader(cueSheet, binSize);

  // Check CDRWIN-style and whether we need gap insertion
  const allTracks: CueTrack[] = [];
  for (const file of cueSheet.files) {
    allTracks.push(...file.tracks);
  }

  let pregapCount = 0;
  let postgapCount = 0;
  for (const track of allTracks) {
    if (track.pregap) pregapCount++;
    if (track.postgap) postgapCount++;
  }
  const isCdrwin = pregapCount === 1 && postgapCount === 0;
  log.verbose(
    `VCD header: ${allTracks.length} track(s), ${pregapCount} pregap(s), ` +
      `${postgapCount} postgap(s)${isCdrwin ? " — CDRWIN style" : ""}`
  );

  // Find gap insertion point for CDRWIN fix
  let gapInsertOffset = -1;
  if (isCdrwin && allTracks.length > 1) {
    // Insert 150 sectors of zeros between data track and first audio track
    const firstAudioTrack = allTracks.find((t) => !isDataTrack(t));
    if (firstAudioTrack) {
      const idx01 = firstAudioTrack.indexes.find((idx) => idx.number === 1);
      if (idx01) {
        const sectors = msfToSectors(idx01.minutes, idx01.seconds, idx01.frames);
        gapInsertOffset = sectors * SECTOR_SIZE;
        log.verbose(`CDRWIN fix: inserting 150-sector gap at byte ${gapInsertOffset}`);
      }
    }
  }

  if (onProgress) onProgress(10, "Writing VCD file");

  // Write output: header + BIN data (with optional gap insertion)
  const writeStream = fsSync.createWriteStream(outputVcdPath);

  // Write header
  await new Promise<void>((resolve, reject) => {
    writeStream.write(header, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Stream BIN data
  const totalBytes = binSize;
  let writtenBytes = 0;

  if (gapInsertOffset > 0 && gapInsertOffset < binSize) {
    // CDRWIN fix: insert 150 sectors of zeros at the gap point
    const gapSize = 150 * SECTOR_SIZE; // 352800 bytes

    // Write first part of BIN
    await new Promise<void>((resolve, reject) => {
      const part1 = fsSync.createReadStream(binPath, {
        start: 0,
        end: gapInsertOffset - 1,
      });
      part1.on("data", (chunk: Buffer) => {
        writtenBytes += chunk.length;
        if (onProgress) {
          onProgress(
            10 + Math.round((writtenBytes / totalBytes) * 85),
            "Writing VCD data"
          );
        }
      });
      part1.on("error", reject);
      part1.on("end", resolve);
      part1.pipe(writeStream, { end: false });
    });

    // Write gap (zeros)
    const gapBuffer = Buffer.alloc(gapSize, 0);
    await new Promise<void>((resolve, reject) => {
      writeStream.write(gapBuffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Write remaining BIN data
    await new Promise<void>((resolve, reject) => {
      const part2 = fsSync.createReadStream(binPath, {
        start: gapInsertOffset,
      });
      part2.on("data", (chunk: Buffer) => {
        writtenBytes += chunk.length;
        if (onProgress) {
          onProgress(
            10 + Math.round((writtenBytes / totalBytes) * 85),
            "Writing VCD data"
          );
        }
      });
      part2.on("error", reject);
      part2.on("end", resolve);
      part2.pipe(writeStream, { end: false });
    });
  } else {
    // Standard: just stream the whole BIN
    await new Promise<void>((resolve, reject) => {
      const readStream = fsSync.createReadStream(binPath);
      readStream.on("data", (chunk: Buffer) => {
        writtenBytes += chunk.length;
        if (onProgress) {
          onProgress(
            10 + Math.round((writtenBytes / totalBytes) * 85),
            "Writing VCD data"
          );
        }
      });
      readStream.on("error", reject);
      readStream.on("end", resolve);
      readStream.pipe(writeStream, { end: false });
    });
  }

  writeStream.end();
  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  if (onProgress) onProgress(100, "Conversion complete");
  log.info(`VCD conversion complete → ${outputVcdPath}`);
}

interface VcdTrackInfo {
  number: number;
  isData: boolean;
  index00: MsfBcd;
  index01: MsfBcd;
}

interface VcdHeaderInfo {
  trackCount: number;
  tracks: VcdTrackInfo[];
}

/**
 * Parses the fixed 1 MiB "kHn " header `buildHeader()` writes, recovering
 * each track's type and INDEX 00/01 timestamps (still including the +2/+4
 * second fudge `buildHeader()` bakes in — callers undo that separately).
 */
function parseVcdHeader(header: Buffer): VcdHeaderInfo {
  if (!SIGNATURE.equals(header.subarray(1024, 1024 + SIGNATURE.length))) {
    throw new Error("Not a valid VCD file (missing kHn signature).");
  }

  const trackCount = fromBcd(header[17]);
  if (!trackCount || trackCount < 1 || trackCount > 99) {
    throw new Error("VCD header has an invalid track count.");
  }

  const tracks: VcdTrackInfo[] = [];
  for (let i = 0; i < trackCount; i++) {
    const offset = 30 + i * 10;
    tracks.push({
      number: fromBcd(header[offset + 2]),
      isData: header[offset] === 0x41,
      index00: {
        mm: fromBcd(header[offset + 3]),
        ss: fromBcd(header[offset + 4]),
        ff: fromBcd(header[offset + 5]),
      },
      index01: {
        mm: fromBcd(header[offset + 7]),
        ss: fromBcd(header[offset + 8]),
        ff: fromBcd(header[offset + 9]),
      },
    });
  }

  return { trackCount, tracks };
}

/**
 * Converts a VCD (POPS/PS1) image back to BIN/CUE — the inverse of
 * `convertToVcd()`. The VCD header only stores each track's INDEX 00/01
 * timestamps *after* `buildHeader()`'s +2/+4 second adjustment, and whether
 * that adjustment was +2 or +4 (the "CDRWIN fix") isn't recorded anywhere —
 * so this reconstructs it by testing the +4/gap-inserted hypothesis first:
 * if the 150-sector run at the hypothesised gap position is all zero, this
 * is a CDRWIN-style single-pregap disc and that physical gap is stripped
 * back out; otherwise it falls back to +2 with no gap. This exactly
 * round-trips discs this tool produced; third-party VCDs with more unusual
 * pregap/postgap layouts may need manual CUE touch-up.
 *
 * Track MODE is not recoverable from the header (it only stores "data" vs
 * "audio"), so data tracks are always emitted as MODE2/2352.
 */
export async function convertVcdToBin(
  vcdPath: string,
  outputBinPath: string,
  outputCuePath: string,
  onProgress?: (percent: number, stage: string) => void
): Promise<{ trackCount: number; hadGap: boolean }> {
  const fileSize = (await fs.stat(vcdPath)).size;
  if (fileSize <= HEADER_SIZE) {
    throw new Error("VCD file is too small to contain a valid header.");
  }

  if (onProgress) onProgress(5, "Reading VCD header");

  const handle = await fs.open(vcdPath, "r");
  let headerInfo: VcdHeaderInfo;
  let header: Buffer;
  try {
    header = Buffer.alloc(HEADER_SIZE);
    await handle.read(header, 0, HEADER_SIZE, 0);
    headerInfo = parseVcdHeader(header);

    const payloadSize = fileSize - HEADER_SIZE;
    const { tracks } = headerInfo;

    // Detect the CDRWIN gap fix: try +4s on the first non-data track and see
    // if a physical 150-sector zero gap sits where that would put it.
    let addSec = 2;
    let gapOffset = -1;
    const firstAudioIdx = tracks.findIndex((t) => !t.isData);
    if (firstAudioIdx > 0) {
      const candidateRaw = addSeconds(
        tracks[firstAudioIdx].index01.mm,
        tracks[firstAudioIdx].index01.ss,
        tracks[firstAudioIdx].index01.ff,
        -4
      );
      const candidateOffset =
        msfToSectors(candidateRaw.mm, candidateRaw.ss, candidateRaw.ff) *
        SECTOR_SIZE;
      const gapSize = 150 * SECTOR_SIZE;
      if (candidateOffset >= 0 && candidateOffset + gapSize <= payloadSize) {
        const probe = Buffer.alloc(gapSize);
        await handle.read(probe, 0, gapSize, HEADER_SIZE + candidateOffset);
        if (probe.every((b) => b === 0)) {
          addSec = 4;
          gapOffset = candidateOffset;
        }
      }
    }

    log.info(
      `Converting VCD→BIN/CUE: ${vcdPath} (${tracks.length} track(s)` +
        (gapOffset >= 0 ? `, CDRWIN gap at byte ${gapOffset}` : "") +
        ")"
    );

    if (onProgress) onProgress(15, "Rebuilding CUE sheet");

    const cueLines: string[] = [
      `FILE "${path.basename(outputBinPath)}" BINARY`,
    ];

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const type = track.isData ? "MODE2/2352" : "AUDIO";
      cueLines.push(`  TRACK ${pad2(track.number)} ${type}`);

      const sub = i === 0 ? 2 : addSec;
      const index01Raw = addSeconds(
        track.index01.mm,
        track.index01.ss,
        track.index01.ff,
        -sub
      );

      if (i === firstAudioIdx && gapOffset >= 0) {
        cueLines.push("    PREGAP 00:02:00");
      } else if (i > 0) {
        const index00Raw = addSeconds(
          track.index00.mm,
          track.index00.ss,
          track.index00.ff,
          -sub
        );
        if (
          index00Raw.mm !== index01Raw.mm ||
          index00Raw.ss !== index01Raw.ss ||
          index00Raw.ff !== index01Raw.ff
        ) {
          cueLines.push(`    INDEX 00 ${formatMsf(index00Raw)}`);
        }
      } else if (
        track.index00.mm !== 0 ||
        track.index00.ss !== 0 ||
        track.index00.ff !== 0
      ) {
        cueLines.push(`    INDEX 00 ${formatMsf(track.index00)}`);
      }

      cueLines.push(`    INDEX 01 ${formatMsf(index01Raw)}`);
    }

    await fs.writeFile(outputCuePath, cueLines.join("\n") + "\n", "utf-8");

    if (onProgress) onProgress(20, "Extracting BIN data");

    const writeStream = fsSync.createWriteStream(outputBinPath);
    const gapSize = 150 * SECTOR_SIZE;
    let writtenBytes = 0;
    const reportProgress = (chunkLen: number) => {
      writtenBytes += chunkLen;
      if (onProgress) {
        onProgress(
          20 + Math.round((writtenBytes / payloadSize) * 78),
          "Writing BIN data"
        );
      }
    };

    if (gapOffset >= 0) {
      await new Promise<void>((resolve, reject) => {
        const part1 = fsSync.createReadStream(vcdPath, {
          start: HEADER_SIZE,
          end: HEADER_SIZE + gapOffset - 1,
        });
        part1.on("data", (chunk: Buffer) => reportProgress(chunk.length));
        part1.on("error", reject);
        part1.on("end", resolve);
        part1.pipe(writeStream, { end: false });
      });

      await new Promise<void>((resolve, reject) => {
        const part2 = fsSync.createReadStream(vcdPath, {
          start: HEADER_SIZE + gapOffset + gapSize,
        });
        part2.on("data", (chunk: Buffer) => reportProgress(chunk.length));
        part2.on("error", reject);
        part2.on("end", resolve);
        part2.pipe(writeStream, { end: false });
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const readStream = fsSync.createReadStream(vcdPath, {
          start: HEADER_SIZE,
        });
        readStream.on("data", (chunk: Buffer) => reportProgress(chunk.length));
        readStream.on("error", reject);
        readStream.on("end", resolve);
        readStream.pipe(writeStream, { end: false });
      });
    }

    writeStream.end();
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    if (onProgress) onProgress(100, "Conversion complete");
    log.info(`VCD→BIN/CUE conversion complete → ${outputBinPath}`);

    return { trackCount: tracks.length, hadGap: gapOffset >= 0 };
  } finally {
    await handle.close().catch(() => {});
  }
}
