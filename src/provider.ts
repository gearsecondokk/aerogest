/**
 * Aiguillage entre fournisseurs. jobs.ts et bot.ts passent par ici et ignorent
 * lequel des trois répond.
 */
import * as falProvider from "./fal.js";
import * as byteplus from "./byteplus.js";
import * as topview from "./topview.js";
import type { VideoResult } from "./fal.js";

export type Provider = "fal" | "byteplus" | "topview";

export function submitVideo(provider: Provider, endpoint: string, input: Record<string, unknown>): Promise<string> {
  if (provider === "byteplus") return byteplus.submitVideo(endpoint, input);
  if (provider === "topview") return topview.submitVideo(endpoint, input);
  return falProvider.submitVideo(endpoint, input);
}

export async function getStatus(provider: Provider, endpoint: string, id: string): Promise<{ status: string; queue_position?: number }> {
  if (provider === "byteplus") return byteplus.getStatus(endpoint, id);
  if (provider === "topview") return topview.getStatus(endpoint, id);
  const s = await falProvider.getStatus(endpoint, id);
  return { status: s.status, queue_position: (s as { queue_position?: number }).queue_position };
}

export function getResult(provider: Provider, endpoint: string, id: string): Promise<VideoResult> {
  if (provider === "byteplus") return byteplus.getResult(endpoint, id);
  if (provider === "topview") return topview.getResult(endpoint, id);
  return falProvider.getResult(endpoint, id);
}

export function describeError(provider: Provider, err: unknown): string {
  if (provider === "byteplus") return byteplus.describeError(err);
  if (provider === "topview") return topview.describeError(err);
  return falProvider.describeFalError(err);
}
