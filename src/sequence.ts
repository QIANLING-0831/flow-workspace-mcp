import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { BrowserManager } from "./browser-manager.js";
import { FlowAdapter } from "./flow-adapter.js";
import { FlowError } from "./errors.js";
import { FlowStore } from "./store.js";
import type { FlowSequence, GenerationRequest } from "./types.js";

/** Serial shots; each poll completes the current shot before submitting the next. */
export class FlowSequences {
  constructor(private readonly store: FlowStore, private readonly flow: FlowAdapter, private readonly browsers: BrowserManager) {}

  async start(requests: GenerationRequest[]): Promise<FlowSequence> {
    if (!requests.length || requests.length > 50 || requests.some(r => r.mediaType !== "video" || r.outputs !== 1 || r.upscale !== "none")) {
      throw new FlowError("validation_error", "Sequences require 1–50 single-output original video shots.");
    }
    const now = new Date().toISOString();
    const sequence: FlowSequence = { id: randomUUID(), status: "processing", requests: requests.map((r,index) => ({...r,download:true,fileName:r.fileName ?? `shot-${String(index+1).padStart(3,"0")}`})), cursor:0, accountId:requests[0]!.accountId, skippedCreditAccounts:[], jobIds:requests.map(()=>null), results:[], createdAt:now, updatedAt:now };
    await this.store.saveSequence(sequence);
    return this.advance(sequence.id);
  }

  async advance(id: string, waitSeconds = 10): Promise<FlowSequence> {
    // Reuse the existing cross-process lock; never hold an account lock here.
    return this.browsers.runExclusive(`sequence-${id}`, async () => {
      const sequence = await this.store.getSequence(id);
      if (sequence.status !== "processing") return sequence;
      if (sequence.submissionPending) {
        // ponytail: interrupted submission has no safely bound job; stop, never replay.
        sequence.status = "needs_attention";
        sequence.error = "Submission was interrupted before its job ID was saved; do not resubmit automatically.";
        await this.store.saveSequence(sequence);
        return sequence;
      }
      try {
        const currentId = sequence.jobIds[sequence.cursor];
        if (currentId) {
          let job = await this.flow.refreshJob(currentId, waitSeconds);
          sequence.accountId = job.accountId;
          sequence.skippedCreditAccounts = [...new Set([...sequence.skippedCreditAccounts, ...(job.skippedCreditAccounts ?? [])])];
          if (["failed", "needs_attention"].includes(job.status)) {
            sequence.status = job.status === "failed" ? "failed" : "needs_attention";
            sequence.error = job.error ?? "Current shot stopped.";
          } else if (job.status === "completed") {
            if (!job.downloadedFiles?.length) job = await this.flow.downloadJob(job.id);
            if (job.status !== "completed" || job.downloadedFiles?.length !== 1) throw new FlowError("download_failed", "Current shot has no verified single local output.");
            await access(job.downloadedFiles[0]!);
            sequence.results.push({shot:sequence.cursor+1,jobId:job.id,files:[...job.downloadedFiles]});
            sequence.cursor++;
            if (sequence.cursor === sequence.requests.length) sequence.status = "completed";
          }
          await this.store.saveSequence(sequence);
          if (sequence.status !== "processing" || sequence.jobIds[sequence.cursor]) return sequence;
        }
        sequence.submissionPending = true;
        await this.store.saveSequence(sequence);
        const input = sequence.requests[sequence.cursor]!;
        const job = await this.flow.generate({...input,accountId:sequence.accountId,download:true}, sequence.skippedCreditAccounts, async created => {
          sequence.jobIds[sequence.cursor] = created.id;
          sequence.submissionPending = false;
          await this.store.saveSequence(sequence);
        });
        sequence.jobIds[sequence.cursor] = job.id;
        sequence.accountId = job.accountId;
        sequence.skippedCreditAccounts = [...new Set([...sequence.skippedCreditAccounts,...(job.skippedCreditAccounts ?? [])])];
        sequence.submissionPending = false;
        if (["failed","needs_attention"].includes(job.status)) {
          sequence.status = job.status === "failed" ? "failed" : "needs_attention";
          sequence.error = job.error ?? "Current shot stopped.";
        }
      } catch (error) {
        sequence.status = sequence.submissionPending ? "needs_attention" : "failed";
        sequence.error = error instanceof FlowError ? `Sequence stopped: ${error.code}` : "Sequence stopped; inspect its current job before continuing.";
      }
      await this.store.saveSequence(sequence);
      return sequence;
    });
  }
}
