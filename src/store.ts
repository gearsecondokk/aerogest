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

/** Duel proposé, en attente du ✅ de l'utilisateur. */
export interface PendingDuel {
  /** Tous les modèles présentés sur la carte, cochés ou non. */
  candidates: string[];
  /** Ceux qui partiront réellement — l'utilisateur coche et décoche. */
  selected: string[];
  options: Options;
  prompt: string;
  negativePrompt: string | null;
  taskKind: string;
  /** Des images sont empilées dans la session : la carte peut alors
   *  signaler les modèles qui refuseront une photo de personne. */
  withImages?: boolean;
  totalUsd: number;
  messageId?: number;
  createdAt: number;
}

/** Bilan par modèle et par type de tâche, alimenté par les verdicts. */
export interface Rating {
  wins: number;
  runs: number;
}

export interface Session {
  chatId: number;
  /** Conversation avec Claude (messages user/assistant + résultats d'outils) */
  history: HistoryMessage[];
  /** Dernière image reçue — c'est elle qu'utilise l'image→vidéo. */
  imageUrl?: string;
  /** Toutes les images de la conversation, dans l'ordre. Le mode
   *  référence→vidéo s'en sert pour tenir un personnage cohérent. */
  imageUrls?: string[];
  imageFileId?: string;
  pending?: PendingGeneration;
  pendingDuel?: PendingDuel;
  updatedAt: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  /** Duel auquel ce job appartient : plusieurs modèles lancés sur la MÊME
   *  tâche, pour comparer. Vide = génération isolée. */
  duelId?: string;
  /** Empêche de redemander le verdict si un autre job du duel finit après. */
  verdictAsked?: boolean;
  /** Nature de la tâche, clé du classement : i2v, r2v… */
  taskKind?: string;
  /** Fournisseur ayant exécuté ce job (défaut fal, pour les jobs anciens). */
  provider?: "fal" | "byteplus";
  /** Prompt après réécriture par le modèle, si communiqué. */
  expandedPrompt?: string | null;
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
  /** taskKind → modelId → {wins, runs} */
  ratings?: Record<string, Record<string, Rating>>;
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

  /* ── Duels et classement ───────────────────────────────────────────
   * On lance plusieurs modèles sur la MÊME tâche, l'utilisateur désigne le
   * meilleur, et on accumule un classement par type de tâche. Le but n'est
   * pas de désigner un « meilleur modèle » dans l'absolu — ça n'existe pas —
   * mais de savoir lequel gagne SUR CE GENRE DE DEMANDE, avec ses propres
   * critères à lui. */

  jobsForDuel(duelId: string): Job[] {
    return Object.values(this.data.jobs).filter((j) => j.duelId === duelId);
  }

  /** Enregistre le verdict : un gagnant, et tous les participants comptés. */
  recordDuelWinner(taskKind: string, winnerId: string, participantIds: string[]): void {
    this.data.ratings ??= {};
    const board = (this.data.ratings[taskKind] ??= {});
    for (const id of participantIds) {
      board[id] ??= { wins: 0, runs: 0 };
      board[id].runs += 1;
    }
    board[winnerId] ??= { wins: 0, runs: 0 };
    board[winnerId].wins += 1;
    this.scheduleWrite();
  }

  /** Classement d'un type de tâche, ou de tous, trié par taux de victoire. */
  ratings(taskKind?: string): Record<string, Array<{ modelId: string; wins: number; runs: number; rate: number }>> {
    const all = this.data.ratings ?? {};
    const kinds = taskKind ? [taskKind] : Object.keys(all);
    const out: Record<string, Array<{ modelId: string; wins: number; runs: number; rate: number }>> = {};
    for (const k of kinds) {
      const board = all[k];
      if (!board) continue;
      out[k] = Object.entries(board)
        .map(([modelId, r]) => ({ modelId, wins: r.wins, runs: r.runs, rate: r.runs ? r.wins / r.runs : 0 }))
        .sort((a, b) => b.rate - a.rate || b.runs - a.runs);
    }
    return out;
  }

}
