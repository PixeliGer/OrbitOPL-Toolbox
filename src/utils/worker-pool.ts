import { Worker } from "worker_threads";
import os from "os";

/**
 * Small fixed-size pool of persistent worker_threads workers, each processing
 * one job at a time. Jobs submitted beyond the pool size queue up and are
 * dispatched as workers free up — callers don't need to manage concurrency
 * themselves, just call `run()` as many times as needed.
 */
export class WorkerPool<TPayload = any, TResult = any> {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private readonly queue: {
    payload: TPayload;
    transferList: any[];
    resolve: (result: TResult) => void;
    reject: (err: any) => void;
  }[] = [];
  private readonly pending = new Map<
    Worker,
    { resolve: (result: TResult) => void; reject: (err: any) => void }
  >();

  constructor(
    private readonly scriptPath: string,
    size?: number
  ) {
    const poolSize = Math.max(1, size ?? WorkerPool.defaultSize());
    for (let i = 0; i < poolSize; i++) {
      this.workers.push(this.spawn());
    }
    this.idle = [...this.workers];
  }

  static defaultSize(): number {
    return Math.max(1, Math.min(os.cpus().length, 8));
  }

  get size(): number {
    return this.workers.length;
  }

  private spawn(): Worker {
    const worker = new Worker(this.scriptPath);
    worker.on("message", (msg) => this.handleMessage(worker, msg));
    worker.on("error", (err) => this.handleError(worker, err));
    return worker;
  }

  run(payload: TPayload, transferList: any[] = []): Promise<TResult> {
    return new Promise((resolve, reject) => {
      const task = { payload, transferList, resolve, reject };
      const worker = this.idle.pop();
      if (worker) {
        this.dispatch(worker, task);
      } else {
        this.queue.push(task);
      }
    });
  }

  private dispatch(
    worker: Worker,
    task: {
      payload: TPayload;
      transferList: any[];
      resolve: (result: TResult) => void;
      reject: (err: any) => void;
    }
  ): void {
    this.pending.set(worker, { resolve: task.resolve, reject: task.reject });
    worker.postMessage(task.payload, task.transferList);
  }

  private handleMessage(worker: Worker, msg: any): void {
    const task = this.pending.get(worker);
    if (!task) return;
    this.pending.delete(worker);
    if (msg && msg.error) {
      task.reject(new Error(msg.error));
    } else {
      task.resolve(msg);
    }
    this.next(worker);
  }

  private handleError(worker: Worker, err: any): void {
    const task = this.pending.get(worker);
    this.pending.delete(worker);
    task?.reject(err);

    // Replace the dead worker so the pool keeps its intended size.
    this.workers = this.workers.filter((w) => w !== worker);
    const idleIdx = this.idle.indexOf(worker);
    if (idleIdx !== -1) this.idle.splice(idleIdx, 1);
    const replacement = this.spawn();
    this.workers.push(replacement);
    this.next(replacement);
  }

  private next(worker: Worker): void {
    const task = this.queue.shift();
    if (task) {
      this.dispatch(worker, task);
    } else {
      this.idle.push(worker);
    }
  }

  async destroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
    this.queue.length = 0;
    this.pending.clear();
  }
}

/**
 * Runs `count` indexed tasks with at most `limit` running concurrently.
 * Each of the `limit` runners pulls the next index off a shared cursor as
 * soon as it finishes its current one, so work stays balanced even when
 * individual tasks take very different amounts of time.
 */
export async function runWithConcurrency(
  count: number,
  limit: number,
  task: (index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  async function runner(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= count) return;
      await task(i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, count) }, () =>
    runner()
  );
  await Promise.all(runners);
}
