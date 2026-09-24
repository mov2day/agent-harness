import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

export type Tokenizer = "o200k_base" | "cl100k_base" | "utf8_bytes";
const workerSource = `
  const {parentPort, workerData} = require("node:worker_threads");
  const {Tiktoken} = require(workerData.lite);
  const encodings = new Map();
  parentPort.on("message", ({id, text, encoding, ceiling}) => {
    try {
      let count = 0;
      if (encoding === "utf8_bytes") count = Buffer.byteLength(text);
      else {
        let encoder = encodings.get(encoding);
        if (!encoder) {
          const rank = require(workerData[encoding]);
          encoder = new Tiktoken(rank.default ?? rank);
          encodings.set(encoding, encoder);
        }
        for (let start = 0; start < text.length; start += 256) {
          count += encoder.encode(text.slice(start, start + 256), [], []).length + 8;
          if (count > ceiling) break;
        }
      }
      parentPort.postMessage({id, count});
    } catch { parentPort.postMessage({id, error: "tokenizer_failed"}); }
  });
`;
/** Tokenization is CPU work on untrusted text. Keep it off the authorization
 * event loop, bound queued jobs, and stop counting once rejection is certain. */
export class TokenCounter {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (count: number) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  count(value: unknown, encoding: Tokenizer, ceiling: number): Promise<number> {
    if (this.closed || this.pending.size >= 8)
      return Promise.reject(new Error("tokenizer_unavailable"));
    if (
      !Number.isSafeInteger(ceiling) ||
      ceiling < 0 ||
      !["o200k_base", "cl100k_base", "utf8_bytes"].includes(encoding)
    )
      return Promise.reject(new Error("tokenizer_configuration"));
    let text: string;
    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
      if (typeof text !== "string" || Buffer.byteLength(text) > 2_000_000)
        throw new Error();
    } catch {
      return Promise.reject(new Error("tokenizer_input"));
    }
    if (!this.worker) {
      const require = createRequire(import.meta.url);
      const worker = (this.worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          lite: require.resolve("js-tiktoken/lite"),
          o200k_base: require.resolve("js-tiktoken/ranks/o200k_base"),
          cl100k_base: require.resolve("js-tiktoken/ranks/cl100k_base"),
        },
      }));
      worker.on("message", ({ id, count, error }) => {
        if (this.worker !== worker) return;
        const job = this.pending.get(id);
        if (!job) return;
        this.pending.delete(id);
        clearTimeout(job.timer);
        if (error) job.reject(new Error(error));
        else job.resolve(count);
        if (!this.pending.size) worker.unref();
      });
      worker.on("error", () => {
        if (this.worker === worker) this.fail("tokenizer_failed");
      });
      worker.on("exit", () => {
        if (this.worker === worker) this.fail("tokenizer_exited");
      });
    }
    const worker = this.worker,
      id = ++this.sequence;
    worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("tokenizer_timeout"), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ id, text, encoding, ceiling });
      } catch {
        this.fail("tokenizer_failed");
      }
    });
  }
  private fail(reason: string) {
    const worker = this.worker;
    this.worker = undefined;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
    this.pending.clear();
    void worker?.terminate();
  }
  close() {
    this.closed = true;
    this.fail("tokenizer_closed");
  }
}
