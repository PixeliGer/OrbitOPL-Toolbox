import { parentPort } from "worker_threads";
import * as lz4 from "lz4js";

/**
 * CPU-bound half of ZSO (ZISO) compression/decompression, run off the main
 * thread by `WorkerPool` (see zso.service.ts). Each ZISO block is
 * independently compressed/decompressed — no data dependency between
 * blocks — so a chunk of blocks can be handed to any worker without
 * affecting the result; only assembling the final file (which needs blocks
 * in order for compression, byte-exact offsets for decompression) has to
 * happen back on the main thread.
 */

if (!parentPort) {
  throw new Error("zso.worker must be run as a worker_threads Worker");
}

const HASH_SIZE = 1 << 16;
const hashTable = new Uint32Array(HASH_SIZE);

interface CompressJob {
  type: "compress";
  buffer: ArrayBuffer; // raw bytes, zero-padded to numBlocks * blockSize
  blockSize: number;
  numBlocks: number;
}

interface DecompressJob {
  type: "decompress";
  buffer: ArrayBuffer; // raw source bytes spanning exactly this chunk's blocks
  blockSize: number;
  numBlocks: number;
  blockOffsets: ArrayBuffer; // Uint32Array — relative offset into `buffer` per block
  blockFlags: ArrayBuffer; // Uint8Array — 1 = LZ4-compressed, 0 = stored raw
  outLens: ArrayBuffer; // Uint32Array — decompressed length per block (short only for the file's final block)
}

type Job = CompressJob | DecompressJob;

/**
 * Decompresses a single raw LZ4 block, stopping once `dstLen` output bytes
 * have been produced. Mirrors `decompressLz4BlockBounded` in zso.service.ts —
 * see that copy for why bounding on output (not input exhaustion) matters.
 */
function decompressLz4BlockBounded(
  src: Buffer,
  srcOffset: number,
  dst: Buffer,
  dstOffset: number,
  dstLen: number
): void {
  const MIN_MATCH = 4;
  let s = srcOffset;
  let d = dstOffset;
  const dstEnd = dstOffset + dstLen;

  while (d < dstEnd) {
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

    if (d >= dstEnd) break;

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
    for (let i = 0; i < matchLength && d < dstEnd; i++) {
      dst[d++] = dst[matchPos++];
    }
  }
}

function handleCompress(job: CompressJob): void {
  const { blockSize, numBlocks } = job;
  const src = Buffer.from(job.buffer);

  // Worst case: every block falls back to stored-raw (== blockSize each).
  const outArrayBuffer = new ArrayBuffer(numBlocks * blockSize);
  const outBuf = Buffer.from(outArrayBuffer);
  const sizesArrayBuffer = new ArrayBuffer(numBlocks * 4);
  const sizes = new Uint32Array(sizesArrayBuffer);
  const flagsArrayBuffer = new ArrayBuffer(numBlocks);
  const flags = new Uint8Array(flagsArrayBuffer);
  const compBuf = new Uint8Array(lz4.compressBound(blockSize));

  let outPos = 0;
  for (let i = 0; i < numBlocks; i++) {
    const blockStart = i * blockSize;

    hashTable.fill(0);
    const compSize = lz4.compressBlock(
      src,
      compBuf,
      blockStart,
      blockSize,
      hashTable
    );

    let storedLen: number;
    if (compSize > 0 && compSize < blockSize) {
      Buffer.from(compBuf.buffer, compBuf.byteOffset, compSize).copy(
        outBuf,
        outPos
      );
      storedLen = compSize;
      flags[i] = 1;
    } else {
      src.copy(outBuf, outPos, blockStart, blockStart + blockSize);
      storedLen = blockSize;
      flags[i] = 0;
    }

    sizes[i] = storedLen;
    outPos += storedLen;
  }

  parentPort!.postMessage(
    {
      type: "compress-result",
      outBuffer: outArrayBuffer,
      outLen: outPos,
      sizes: sizesArrayBuffer,
      flags: flagsArrayBuffer,
      numBlocks,
    },
    [outArrayBuffer, sizesArrayBuffer, flagsArrayBuffer]
  );
}

function handleDecompress(job: DecompressJob): void {
  const { blockSize, numBlocks } = job;
  const src = Buffer.from(job.buffer);
  const blockOffsets = new Uint32Array(job.blockOffsets);
  const blockFlags = new Uint8Array(job.blockFlags);
  const outLens = new Uint32Array(job.outLens);

  let totalOut = 0;
  for (let i = 0; i < numBlocks; i++) totalOut += outLens[i];

  const outArrayBuffer = new ArrayBuffer(totalOut);
  const outBuf = Buffer.from(outArrayBuffer);

  let dPos = 0;
  for (let i = 0; i < numBlocks; i++) {
    const outLen = outLens[i];
    if (outLen <= 0) continue;
    const srcOffset = blockOffsets[i];

    if (blockFlags[i] === 1) {
      decompressLz4BlockBounded(src, srcOffset, outBuf, dPos, outLen);
    } else {
      src.copy(outBuf, dPos, srcOffset, srcOffset + outLen);
    }
    dPos += outLen;
  }

  parentPort!.postMessage(
    { type: "decompress-result", outBuffer: outArrayBuffer, outLen: totalOut },
    [outArrayBuffer]
  );
}

parentPort.on("message", (job: Job) => {
  try {
    if (job.type === "compress") {
      handleCompress(job);
    } else if (job.type === "decompress") {
      handleDecompress(job);
    } else {
      parentPort!.postMessage({ error: `Unknown job type: ${(job as any)?.type}` });
    }
  } catch (err: any) {
    parentPort!.postMessage({ error: err?.message || String(err) });
  }
});
