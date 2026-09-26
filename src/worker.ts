import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export interface WorkerResult {
  status: "completed" | "failed" | "killed";
  finalAnswer: string;
  error?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** Only finalized assistant text enters the inbox. Never thinking or tool output. */
export class ResultCollector {
  private buffer = "";
  private dropping = false;
  finalAnswer = "";
  stopReason?: string;
  error?: string;
  readonly maxLine = 4 * 1024 * 1024;

  push(text: string): void {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.dropping) this.buffer += part;
      if (this.buffer.length > this.maxLine) {
        this.buffer = "";
        this.dropping = true;
        this.stopReason = undefined;
        this.finalAnswer = "";
        this.error = "Worker event exceeded the 4 MiB parser limit; inspect the event log";
      }
      if (part.endsWith("\n")) {
        if (!this.dropping) this.line(this.buffer);
        this.buffer = "";
        this.dropping = false;
      }
    }
  }

  end(): void {
    if (!this.dropping && this.buffer.trim()) this.line(this.buffer);
    this.buffer = "";
  }

  private line(line: string): void {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type !== "message_end" || event.message?.role !== "assistant") return;
    const message = event.message;
    this.stopReason = message.stopReason;
    this.error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    this.finalAnswer = Array.isArray(message.content)
      ? message.content.filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text).join("\n") : "";
  }

  result(code: number | null, signal: NodeJS.Signals | null, failure?: string, timedOut = false): WorkerResult {
    const complete = code === 0 && this.stopReason === "stop" && !failure && !timedOut;
    return {
      status: timedOut ? "killed" : complete ? "completed" : "failed",
      finalAnswer: this.finalAnswer,
      exitCode: code, signal,
      error: complete ? undefined : failure ?? this.error ?? `Worker exited without a complete answer (${this.stopReason ?? "no final message"}, exit ${code})`,
    };
  }
}

export interface WorkerOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  outputPath: string;
  stderrPath: string;
  timeoutSeconds?: number;
}

/** Install all listeners synchronously before returning; settle only on close. */
export function launchWorker(options: WorkerOptions, spawnProcess: typeof spawn = spawn): {
  child: ChildProcess;
  completion: Promise<WorkerResult>;
} {
  const output = createWriteStream(options.outputPath, { mode: 0o600 });
  const diagnostics = createWriteStream(options.stderrPath, { mode: 0o600 });
  const collector = new ResultCollector();
  const decoder = new StringDecoder("utf8");
  let failure: string | undefined;
  let timedOut = false;
  let child: ChildProcess;
  // Capture asynchronous open/write failures instead of crashing the parent.
  const streamFailure = (error: Error) => {
    failure = `Unable to save worker logs: ${error.message}`;
    child?.kill();
  };
  output.on("error", streamFailure);
  diagnostics.on("error", streamFailure);
  try {
    child = spawnProcess(options.command, options.args, {
      cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    });
  } catch (error) {
    output.destroy(); diagnostics.destroy();
    throw error;
  }
  const completion = new Promise<WorkerResult>((resolve) => {
    child.stdout?.pipe(output, { end: false });
    child.stderr?.pipe(diagnostics, { end: false });
    child.stdout?.on("data", (data: Buffer) => collector.push(decoder.write(data)));
    child.on("error", (error) => { failure = error.message; });
    const timeout = options.timeoutSeconds ? setTimeout(() => {
      timedOut = true;
      failure = `Timed out after ${options.timeoutSeconds} seconds; termination requested`;
      child.kill();
    }, options.timeoutSeconds * 1000) : undefined;
    timeout?.unref();
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      collector.push(decoder.end());
      collector.end();
      const finish = (stream: typeof output) => new Promise<void>((done) => {
        if (stream.destroyed) return done();
        stream.once("error", () => done());
        stream.end(done);
      });
      void Promise.all([finish(output), finish(diagnostics)]).then(() => {
        resolve(collector.result(code, signal, failure, timedOut));
      });
    });
  });
  return { child, completion };
}
