export interface JobRow {
  id: number;
  publicId: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedJob {
  job: JobRow;
  attemptId: number;
  /** True if this claim reclaimed a job whose previous lease had expired
   * (i.e. the job was already 'processing' when this worker found it). */
  reclaimed: boolean;
}
