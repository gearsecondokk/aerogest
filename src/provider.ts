/**
 * Aiguillage entre fournisseurs. jobs.ts et bot.ts passent par ici et ignorent
 * lequel des deux répond.
 */
import * as falProvider from "./fal.js";
import * as byteplus from "./byteplus.js";
import type { VideoResult } from "./fal.js";

export type Provider = "fal" | "byteplus";

export function submitVideo(provider: Provider, endpoint: string, input: Record<string, unknown>): Promise<string> {
  return provider === "byteplus" ? byteplus.submitVideo(endpoint, input) : falProvider.submitVideo(endpoint, input);
}

export async function getStatus(provider: Provider, endpoint: string, id: string): Promise<{ status: string; queue_position?: number }> {
  if (provider === "byteplus") return byteplus.getStatus(endpoint, id);
  const s = await falProvider.getStatus(endpoint, id);
  return { status: s.status, queue_position: (s as { queue_position?: number }).queue_position };
}

export function getResult(provider: Provider, endpoint: string, id: string): Promise<VideoResult> {
  return provider === "byteplus" ? byteplus.getResult(endpoint, id) : falProvider.getResult(endpoint, id);
}

export function describeError(provider: Provider, err: unknown): string {
  return provider === "byteplus" ? byteplus.describeError(err) : falProvider.describeFalError(err);
}
