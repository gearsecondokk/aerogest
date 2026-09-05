import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Options } from "./models.js";

export type HistoryMessage = Anthropic.Beta.BetaMessageParam;

/** Génération proposée par Claude, en attente du ✅ de l'utilisateur. */
export interface PendingGeneration {
  modelId: string;
  options: Options;
  prompt: string;
  negativePrompt: string | null;
  estimateUsd: number;
  billedSeconds: number;
  /** Message Telegram portant les boutons de confirmation */
  messageId?: number;
  createdAt: number;
}

export interface Session {
  chatId: number;
  /** Conversation avec Claude (messages user/assistant + résultats d'outils) */
  history: HistoryMessage[];
  imageUrl?: string;
  imageFileId?: string;
  pending?: PendingGeneration;
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
        // Sessions d'un ancien format : on repart d'un historique vide
        for (const s of Object.values(this.data.sessions)) {
          if (!Array.isArray(s.history)) s.history = [];
        }
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
      s = { chatId, history: [], updatedAt: Date.now() };
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

  resetSession(chatId: number): Session {
    const fresh: Session = { chatId, history: [], updatedAt: Date.now() };
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
