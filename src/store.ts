import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Options } from "./models.js";

export type SessionState =
  | "idle"
  | "awaiting_model"
  | "awaiting_options"
  | "awaiting_idea"
  | "refining"
  | "awaiting_manual"
  | "awaiting_confirm";

export interface Proposal {
  prompt: string;
  negative_prompt: string | null;
  explanation: string;
  question: string | null;
}

export interface Session {
  chatId: number;
  state: SessionState;
  imageUrl?: string;
  imageFileId?: string;
  modelId?: string;
  options: Options;
  /** Historique de la conversation avec Claude pour ce prompt */
  history: Anthropic.MessageParam[];
  proposal?: Proposal;
  estimateUsd?: number;
  updatedAt: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  chatId: number;
  userId: number;
  requestId: string;
  modelId: string;
  endpoint: string;
  input: Record<string, unknown>;
  prompt: string;
  estimateUsd: number;
  status: JobStatus;
  statusMessageId?: number;
  queuePosition?: number;
  videoUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}

interface StateFile {
  sessions: Record<string, Session>;
  jobs: Record<string, Job>;
  /** Dépenses estimées par jour (YYYY-MM-DD → USD) */
  spend: Record<string, number>;
}

export class Store {
  private data: StateFile = { sessions: {}, jobs: {}, spend: {} };
  private readonly file: string;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "state.json");
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StateFile>;
        this.data = {
          sessions: raw.sessions ?? {},
          jobs: raw.jobs ?? {},
          spend: raw.spend ?? {},
        };
      } catch (err) {
        console.error(`Impossible de lire ${this.file}, on repart de zéro :`, err);
      }
    }
  }

  // --- Sessions ---------------------------------------------------------

  getSession(chatId: number): Session {
    const key = String(chatId);
    let s = this.data.sessions[key];
    if (!s) {
      s = { chatId, state: "idle", options: {}, history: [], updatedAt: Date.now() };
      this.data.sessions[key] = s;
      this.scheduleWrite();
    }
    return s;
  }

  saveSession(session: Session): void {
    session.updatedAt = Date.now();
    this.data.sessions[String(session.chatId)] = session;
    this.scheduleWrite();
  }

  resetSession(chatId: number, keepImage = false): Session {
    const old = this.getSession(chatId);
    const fresh: Session = {
      chatId,
      state: "idle",
      options: {},
      history: [],
      updatedAt: Date.now(),
    };
    if (keepImage) {
      fresh.imageUrl = old.imageUrl;
      fresh.imageFileId = old.imageFileId;
    }
    this.data.sessions[String(chatId)] = fresh;
    this.scheduleWrite();
    return fresh;
  }

  // --- Jobs -------------------------------------------------------------

  addJob(job: Job): void {
    this.data.jobs[job.id] = job;
    this.scheduleWrite();
  }

  saveJob(job: Job): void {
    job.updatedAt = Date.now();
    this.data.jobs[job.id] = job;
    this.scheduleWrite();
  }

  getJob(id: string): Job | undefined {
    return this.data.jobs[id];
  }

  activeJobs(): Job[] {
    return Object.values(this.data.jobs).filter((j) => j.status === "queued" || j.status === "running");
  }

  jobsForChat(chatId: number, limit = 10): Job[] {
    return Object.values(this.data.jobs)
      .filter((j) => j.chatId === chatId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  // --- Dépenses ---------------------------------------------------------

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  spentToday(): number {
    return this.data.spend[this.today()] ?? 0;
  }

  addSpend(usd: number): void {
    const k = this.today();
    this.data.spend[k] = (this.data.spend[k] ?? 0) + usd;
    this.scheduleWrite();
  }

  // --- Persistance ------------------------------------------------------

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 200);
  }

  flush(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("Erreur d'écriture du state :", err);
    }
  }
}
