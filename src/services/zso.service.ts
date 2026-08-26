import * as fs from "fs/promises";
import path from "path";
import { createLogger, formatBytes } from "../logger";
import { WorkerPool, runWithConcurrency } from "../utils/worker-pool";

const log = createLogger("zso");

/**
 * ISO -> ZSO (ZISO) compressor.
 *
 * ZISO is the format Open PS2 Loader reads for compressed images: a small
 * header, a block-offset index, then a sequence of independently-compressed
 * 2 KiB blocks (raw LZ4 *block* format, not the LZ4 frame format). Each block
 * is compressed on its own so OPL can seek to and decompress any block in
 * isolation — matches must never cross a block boundary.
 *
 * Reference: maxcso / ziso.py.
 */

const ZISO_MAGIC = 0x4f53495a; // "ZISO"
const HEADER_SIZE = 0x18; // 24 bytes
const BLOCK_SIZE = 2048;
const VERSION = 1;
const NOT_COMPRESSED = 0x80000000;

// Each ZISO block compresses/decompresses independently of every other
// block, so the work is split into chunks of this many blocks (~8 MiB) and
// spread across a pool of worker threads — one chunk per worker task keeps
// message-passing overhead low while still giving the scheduler plenty of
// chunks to balance across cores on large images.
const PARALLEL_CHUNK_BLOCKS = 4096;

function zsoWorkerScriptPath(): string {
  return path.join(__dirname, "..", "workers", "zso.worker.js");
}

export interface ZsoResult {
  success: boolean;
  message?: string;
  zsoPath?: string;
  isoPath?: string;
  originalBytes?: number;
  compressedBytes?: number;
}

function alignUp(value: number, align: number): number {
  if (align === 0) return value;
  const unit = 1 << align;
  return Math.ceil(value / unit) * unit;
}

/**
 * Picks the smallest alignment shift such that every block offset fits in the
 * 31 usable bits of an index entry (the top bit is the "uncompressed" flag).
 * align=0 caps at 2 GiB; PS2 DVD images can exceed that, so we scale up.
 */
function chooseAlign(maxPossibleOffset: number): number {
  let align = 0;
  while (Math.floor(maxPossibleOffset / Math.pow(2, align)) >= 0x80000000) {
    align++;
  }
  return align;
}

export async function compressIsoToZso(
  isoPath: string,
  zsoPath: string,
  deleteOriginal: boolean,
  onProgress?: (percent: number, stage: string) => void,
): Promise<ZsoResult> {
  let input: fs.FileHandle | null = null;
  let output: fs.FileHandle | null = null;
  let pool: WorkerPool | null = null;

  try {
    input = await fs.open(isoPath, "r");
    const stat = await input.stat();
    const totalBytes = stat.size;

    if (totalBytes === 0) {
      log.error(`Source ISO is empty: ${isoPath}`);
      return { success: false, message: "Source ISO is empty." };
    }

    const numBlocks = Math.ceil(totalBytes / BLOCK_SIZE);
    const indexSize = (numBlocks + 1) * 4;
    const worstCaseEnd = HEADER_SIZE + indexSize + totalBytes + numBlocks; // raw + padding slack
    const align = chooseAlign(worstCaseEnd);

    const totalChunks = Math.ceil(numBlocks / PARALLEL_CHUNK_BLOCKS);
    const poolSize = Math.min(WorkerPool.defaultSize(), totalChunks);
    pool = new WorkerPool(zsoWorkerScriptPath(), poolSize);

    log.info(
      `Compressing ISO → ZSO: ${isoPath} (${formatBytes(totalBytes)}, ` +
        `${numBlocks} × ${BLOCK_SIZE}B blocks) using ${poolSize} worker thread(s)`,
    );
    log.verbose(
      `ZISO params: align=${align} (unit ${1 << align}B), index ${formatBytes(indexSize)}, ` +
        `output ${zsoPath}, ${totalChunks} chunk(s) of ${PARALLEL_CHUNK_BLOCKS} blocks`,
    );

    output = await fs.open(zsoPath, "w");

    // Block index, filled as we stream; written out at the end.
    const index = new Uint32Array(numBlocks + 1);

    let writePos = alignUp(HEADER_SIZE + indexSize, align);
    let blockIndex = 0;
    let lastProgress = -1;
    let lastVerboseMilestone = 0;

    // Chunks compress concurrently across the worker pool (out of order),
    // but the ZISO format packs blocks back-to-back with running offsets, so
    // results must be written out in chunk order. `pendingResults` holds
    // completed-but-not-yet-writable chunks; `drainReady()` flushes whatever
    // prefix is now contiguous whenever a new result arrives.
    const pendingResults = new Map<
      number,
      { outBuffer: ArrayBuffer; sizes: ArrayBuffer; flags: ArrayBuffer; numBlocks: number }
    >();
    let nextToWrite = 0;
    let draining = false;

    const drainReady = async () => {
      if (draining) return;
      draining = true;
      try {
        while (pendingResults.has(nextToWrite)) {
          const result = pendingResults.get(nextToWrite)!;
          pendingResults.delete(nextToWrite);

          const outBuf = Buffer.from(result.outBuffer);
          const sizes = new Uint32Array(result.sizes);
          const flags = new Uint8Array(result.flags);

          // Lay out the whole chunk in one local buffer (any inter-block
          // alignment padding included, left zeroed) and issue a single
          // write for it instead of one write() syscall per block — with
          // 2 KiB blocks that's the difference between a few dozen writes
          // and hundreds of thousands for a full-size DVD image.
          const chunkStartPos = writePos;
          const blockPositions = new Array<number>(result.numBlocks);
          const blockReadOffsets = new Array<number>(result.numBlocks);
          let readOffset = 0;
          let cursor = writePos;
          for (let i = 0; i < result.numBlocks; i++) {
            const alignedPos = alignUp(cursor, align);
            blockPositions[i] = alignedPos;
            blockReadOffsets[i] = readOffset;
            cursor = alignedPos + sizes[i];
            readOffset += sizes[i];
          }

          const chunkBuf = Buffer.alloc(cursor - chunkStartPos);
          for (let i = 0; i < result.numBlocks; i++) {
            const storedLen = sizes[i];
            outBuf.copy(
              chunkBuf,
              blockPositions[i] - chunkStartPos,
              blockReadOffsets[i],
              blockReadOffsets[i] + storedLen,
            );

            let entry = Math.floor(blockPositions[i] / Math.pow(2, align));
            if (flags[i] !== 1) entry += NOT_COMPRESSED;
            index[blockIndex] = entry >>> 0;
            blockIndex++;
          }

          await output!.write(chunkBuf, 0, chunkBuf.length, chunkStartPos);
          writePos = cursor;

          nextToWrite++;

          const percent = Math.floor((blockIndex / numBlocks) * 100);
          if (onProgress && percent !== lastProgress) {
            lastProgress = percent;
            onProgress(percent, "Compressing to ZSO");
          }
          if (percent >= lastVerboseMilestone + 25) {
            lastVerboseMilestone = percent - (percent % 25);
            log.verbose(
              `ZSO compression ${lastVerboseMilestone}% — ${blockIndex}/${numBlocks} blocks, ` +
                `${formatBytes(writePos)} written so far`,
            );
          }
        }
      } finally {
        draining = false;
      }
    };

    await runWithConcurrency(totalChunks, poolSize * 2, async (chunkIdx) => {
      const startBlock = chunkIdx * PARALLEL_CHUNK_BLOCKS;
      const endBlock = Math.min(startBlock + PARALLEL_CHUNK_BLOCKS, numBlocks);
      const nBlocks = endBlock - startBlock;
      const byteLen = nBlocks * BLOCK_SIZE;
      const fileByteStart = startBlock * BLOCK_SIZE;
      const availableBytes = Math.min(byteLen, totalBytes - fileByteStart);

      // Zero-initialised, so any short final block is already zero-padded.
      const readArrayBuffer = new ArrayBuffer(byteLen);
      const readView = Buffer.from(readArrayBuffer);
      await input!.read(readView, 0, availableBytes, fileByteStart);

      const result = await pool!.run(
        { type: "compress", buffer: readArrayBuffer, blockSize: BLOCK_SIZE, numBlocks: nBlocks },
        [readArrayBuffer],
      );

      pendingResults.set(chunkIdx, result);
      await drainReady();
    });

    // End marker: offset just past the last block.
    const endPos = alignUp(writePos, align);
    index[numBlocks] = Math.floor(endPos / Math.pow(2, align)) >>> 0;

    // Write the header.
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(ZISO_MAGIC, 0x00);
    header.writeUInt32LE(HEADER_SIZE, 0x04);
    header.writeBigUInt64LE(BigInt(totalBytes), 0x08);
    header.writeUInt32LE(BLOCK_SIZE, 0x10);
    header.writeUInt8(VERSION, 0x14);
    header.writeUInt8(align, 0x15);
    await output.write(header, 0, HEADER_SIZE, 0);

    // Write the index.
    const indexBuf = Buffer.from(
      index.buffer,
      index.byteOffset,
      index.byteLength,
    );
    await output.write(indexBuf, 0, indexBuf.length, HEADER_SIZE);

    const compressedBytes = (await output.stat()).size;

    // Close the output handle before deleting the source so the new file is
    // fully flushed and we never remove the original on a failed write.
    await output.close();
    output = null;
    await input.close();
    input = null;

    if (deleteOriginal) {
      await fs.unlink(isoPath);
      log.verbose(
        `Deleted source ISO after successful compression: ${isoPath}`,
      );
    }

    if (onProgress) onProgress(100, "ZSO complete");

    const ratio = ((compressedBytes / totalBytes) * 100).toFixed(1);
    log.info(
      `ZSO complete: ${formatBytes(totalBytes)} → ${formatBytes(compressedBytes)} ` +
        `(${ratio}% of original, saved ${formatBytes(totalBytes - compressedBytes)})`,
    );

    return {
      success: true,
      zsoPath,
      originalBytes: totalBytes,
      compressedBytes,
    };
  } catch (err: any) {
    log.error(`ZSO compression failed for ${isoPath}:`, err?.message || err);
    return { success: false, message: err?.message || String(err) };
  } finally {
    await input?.close().catch(() => {});
    await output?.close().catch(() => {});
    await pool?.destroy().catch(() => {});
  }
}

/**
 * Decompresses a single raw LZ4 block, stopping once `dstLen` output bytes have
 * been produced rather than when the input is exhausted. ZISO aligns blocks on
 * 2^align boundaries, so the bytes between a block's compressed payload and the
 * next block are padding — relying on input exhaustion (as lz4js.decompressBlock
 * does) would misread that padding as more LZ4 sequences. Each ZISO block
 * decompresses to a known fixed size, so bounding on output is exact and safe.
 */
function decompressLz4BlockBounded(
  src: Buffer,
  dst: Buffer,
  dstLen: number,
): void {
  const MIN_MATCH = 4;
  let s = 0;
  let d = 0;

  while (d < dstLen) {
    const token = src[s++];

    let literalCount = token >> 4;
    if (literalCount === 0xf) {
      let b: number;
      do {
        b = src[s++];
        literalCount += b;
      } while (b === 0xff);
    }
    for (let i = 0; i < literalCount; i++) {
      dst[d++] = src[s++];
    }

    if (d >= dstLen) break;

    const mOffset = src[s++] | (src[s++] << 8);

    let matchLength = token & 0xf;
    if (matchLength === 0xf) {
      let b: number;
      do {
        b = src[s++];
        matchLength += b;
      } while (b === 0xff);
    }
    matchLength += MIN_MATCH;

    let matchPos = d - mOffset;
    for (let i = 0; i < matchLength && d < dstLen; i++) {
      dst[d++] = dst[matchPos++];
    }
  }
}

export interface ZsoStreamResult {
  success: boolean;
  message?: string;
}

/**
 * Streams the decompressed contents of a ZSO (ZISO) image to `onData`, block by
 * block in order. Return `true` from `onData` to stop early — used to scan a
 * compressed image for its embedded game ID without inflating the whole disc.
 * `maxBytes` caps how much is decompressed before giving up (a safety bound for
 * images where the sought data is never found; real PS2 discs carry the ID in
 * the root directory, well within the first megabyte).
 */
export async function streamZsoContents(
  filepath: string,
  onData: (chunk: Buffer) => boolean | void,
  maxBytes: number = Number.POSITIVE_INFINITY,
): Promise<ZsoStreamResult> {
  let handle: fs.FileHandle | null = null;

  try {
    handle = await fs.open(filepath, "r");

    const header = Buffer.alloc(HEADER_SIZE);
    await handle.read(header, 0, HEADER_SIZE, 0);
    if (header.readUInt32LE(0x00) !== ZISO_MAGIC) {
      log.verbose(`Not a ZISO image (bad magic): ${filepath}`);
      return { success: false, message: "Not a ZSO (ZISO) image." };
    }

    const headerSize = header.readUInt32LE(0x04);
    const totalBytes = Number(header.readBigUInt64LE(0x08));
    const blockSize = header.readUInt32LE(0x10);
    const align = header.readUInt8(0x15);

    if (!blockSize || !totalBytes) {
      log.error(`Malformed ZISO header in ${filepath}`);
      return { success: false, message: "ZSO header is malformed." };
    }

    const numBlocks = Math.ceil(totalBytes / blockSize);
    log.verbose(
      `Streaming ZISO ${filepath}: ${formatBytes(totalBytes)} uncompressed, ` +
        `${numBlocks} blocks of ${blockSize}B, align=${align}` +
        (Number.isFinite(maxBytes) ? `, cap ${formatBytes(maxBytes)}` : ""),
    );
    const indexSize = (numBlocks + 1) * 4;
    const indexBuf = Buffer.alloc(indexSize);
    await handle.read(indexBuf, 0, indexSize, headerSize);

    const unit = Math.pow(2, align);
    const srcBuf = Buffer.alloc(blockSize + unit + 16);
    const dstBuf = Buffer.alloc(blockSize);
    let produced = 0;

    for (let i = 0; i < numBlocks; i++) {
      const rawEntry = indexBuf.readUInt32LE(i * 4) >>> 0;
      const rawNext = indexBuf.readUInt32LE((i + 1) * 4) >>> 0;
      const isCompressed = (rawEntry & NOT_COMPRESSED) === 0;
      const offset = (rawEntry & 0x7fffffff) * unit;
      const nextOffset = (rawNext & 0x7fffffff) * unit;
      const readLen = nextOffset - offset;
      if (readLen <= 0) continue;

      const cappedLen = Math.min(readLen, srcBuf.length);
      await handle.read(srcBuf, 0, cappedLen, offset);

      const outLen = Math.min(blockSize, totalBytes - produced);
      let chunk: Buffer;
      if (isCompressed) {
        decompressLz4BlockBounded(srcBuf, dstBuf, outLen);
        chunk = dstBuf.subarray(0, outLen);
      } else {
        chunk = srcBuf.subarray(0, outLen);
      }
      produced += outLen;

      if (onData(chunk) === true) {
        return { success: true };
      }
      if (produced >= maxBytes) {
        return { success: true };
      }
    }

    return { success: true };
  } catch (err: any) {
    log.error(`Failed while streaming ZISO ${filepath}:`, err?.message || err);
    return { success: false, message: err?.message || String(err) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * ZSO (ZISO) -> ISO decompressor — the inverse of `compressIsoToZso`. Parses
 * the same header/index and LZ4-block-decompresses every block back to its
 * raw 2 KiB, writing the result out as a plain ISO.
 */
export async function decompressZsoToIso(
  zsoPath: string,
  isoPath: string,
  deleteOriginal: boolean,
  onProgress?: (percent: number, stage: string) => void,
): Promise<ZsoResult> {
  let input: fs.FileHandle | null = null;
  let output: fs.FileHandle | null = null;
  let pool: WorkerPool | null = null;

  try {
    input = await fs.open(zsoPath, "r");

    const header = Buffer.alloc(HEADER_SIZE);
    await input.read(header, 0, HEADER_SIZE, 0);
    if (header.readUInt32LE(0x00) !== ZISO_MAGIC) {
      log.error(`Not a ZISO image (bad magic): ${zsoPath}`);
      return { success: false, message: "Not a ZSO (ZISO) image." };
    }

    const headerSize = header.readUInt32LE(0x04);
    const totalBytes = Number(header.readBigUInt64LE(0x08));
    const blockSize = header.readUInt32LE(0x10);
    const align = header.readUInt8(0x15);

    if (!blockSize || !totalBytes) {
      log.error(`Malformed ZISO header in ${zsoPath}`);
      return { success: false, message: "ZSO header is malformed." };
    }

    const numBlocks = Math.ceil(totalBytes / blockSize);
    const indexSize = (numBlocks + 1) * 4;
    const indexBuf = Buffer.alloc(indexSize);
    await input.read(indexBuf, 0, indexSize, headerSize);

    const totalChunks = Math.ceil(numBlocks / PARALLEL_CHUNK_BLOCKS);
    const poolSize = Math.min(WorkerPool.defaultSize(), totalChunks);
    pool = new WorkerPool(zsoWorkerScriptPath(), poolSize);

    log.info(
      `Decompressing ZSO → ISO: ${zsoPath} (${formatBytes(totalBytes)}, ` +
        `${numBlocks} blocks of ${blockSize}B, align=${align}) using ${poolSize} worker thread(s)`,
    );

    output = await fs.open(isoPath, "w");

    const unit = Math.pow(2, align);
    let completedBytes = 0;
    let completedBlocks = 0;
    let lastProgress = -1;
    let lastVerboseMilestone = 0;

    // Each block's output position (blockIndex * blockSize) is fixed and
    // independent of every other block, so — unlike compression's packed,
    // variable-length layout — decompressed chunks can be written to the
    // output file as soon as they're ready, in any order.
    await runWithConcurrency(totalChunks, poolSize * 2, async (chunkIdx) => {
      const startBlock = chunkIdx * PARALLEL_CHUNK_BLOCKS;
      const endBlock = Math.min(startBlock + PARALLEL_CHUNK_BLOCKS, numBlocks);
      const nBlocks = endBlock - startBlock;

      const blockOffsets = new Uint32Array(nBlocks);
      const blockFlags = new Uint8Array(nBlocks);
      const outLens = new Uint32Array(nBlocks);

      const chunkFileStart =
        ((indexBuf.readUInt32LE(startBlock * 4) >>> 0) & 0x7fffffff) * unit;
      const chunkFileEnd =
        ((indexBuf.readUInt32LE(endBlock * 4) >>> 0) & 0x7fffffff) * unit;
      const chunkReadLen = Math.max(0, chunkFileEnd - chunkFileStart);

      let produced = startBlock * blockSize;
      for (let i = 0; i < nBlocks; i++) {
        const gi = startBlock + i;
        const rawEntry = indexBuf.readUInt32LE(gi * 4) >>> 0;
        const isCompressed = (rawEntry & NOT_COMPRESSED) === 0;
        const offset = (rawEntry & 0x7fffffff) * unit;

        blockOffsets[i] = offset - chunkFileStart;
        blockFlags[i] = isCompressed ? 1 : 0;
        outLens[i] = Math.max(0, Math.min(blockSize, totalBytes - produced));
        produced += blockSize;
      }

      const srcArrayBuffer = new ArrayBuffer(chunkReadLen);
      if (chunkReadLen > 0) {
        const srcView = Buffer.from(srcArrayBuffer);
        await input!.read(srcView, 0, chunkReadLen, chunkFileStart);
      }

      const result = await pool!.run(
        {
          type: "decompress",
          buffer: srcArrayBuffer,
          blockSize,
          numBlocks: nBlocks,
          blockOffsets: blockOffsets.buffer,
          blockFlags: blockFlags.buffer,
          outLens: outLens.buffer,
        },
        [
          srcArrayBuffer,
          blockOffsets.buffer,
          blockFlags.buffer,
          outLens.buffer,
        ],
      );

      const outBuf = Buffer.from(result.outBuffer);
      await output!.write(outBuf, 0, result.outLen, startBlock * blockSize);

      completedBytes += result.outLen;
      completedBlocks += nBlocks;

      const percent = Math.floor((completedBytes / totalBytes) * 100);
      if (onProgress && percent !== lastProgress) {
        lastProgress = percent;
        onProgress(percent, "Decompressing ZSO");
      }
      if (percent >= lastVerboseMilestone + 25) {
        lastVerboseMilestone = percent - (percent % 25);
        log.verbose(
          `ZSO decompression ${lastVerboseMilestone}% — ${completedBlocks}/${numBlocks} blocks, ` +
            `${formatBytes(completedBytes)} written so far`,
        );
      }
    });

    await output.close();
    output = null;
    await input.close();
    input = null;

    if (deleteOriginal) {
      await fs.unlink(zsoPath);
      log.verbose(
        `Deleted source ZSO after successful decompression: ${zsoPath}`,
      );
    }

    if (onProgress) onProgress(100, "ISO complete");

    log.info(
      `ZSO decompression complete: ${formatBytes(totalBytes)} written → ${isoPath}`,
    );

    return {
      success: true,
      isoPath,
      originalBytes: totalBytes,
      compressedBytes: totalBytes,
    };
  } catch (err: any) {
    log.error(`ZSO decompression failed for ${zsoPath}:`, err?.message || err);
    return { success: false, message: err?.message || String(err) };
  } finally {
    await input?.close().catch(() => {});
    await output?.close().catch(() => {});
    await pool?.destroy().catch(() => {});
  }
}
