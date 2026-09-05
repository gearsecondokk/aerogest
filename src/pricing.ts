import { config } from "./config.js";
import type { Options, VideoModel } from "./models.js";

export interface LiveUnitPrice {
  unit_price: number;
  unit: string;
  currency: string;
}

export interface CostEstimate {
  /** Estimation locale (table de prix du registre) */
  usd: number;
  billedSeconds: number;
  /** Tarif unitaire renvoyé par l'API pricing de fal, si disponible */
  live?: LiveUnitPrice;
  /** Estimation calculée à partir du tarif live quand l'unité est la seconde */
  liveUsd?: number;
}

const cache = new Map<string, { at: number; price: LiveUnitPrice | null }>();
const TTL_MS = 60 * 60 * 1000;

/** GET https://api.fal.ai/v1/models/pricing?endpoint_id=… (mis en cache 1 h) */
export async function fetchLiveUnitPrice(endpoint: string): Promise<LiveUnitPrice | null> {
  const hit = cache.get(endpoint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;

  let price: LiveUnitPrice | null = null;
  try {
    const url = `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(endpoint)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Key ${config.FAL_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const body = (await res.json()) as { prices?: LiveUnitPrice[] & { endpoint_id?: string }[] };
      const entry = body.prices?.find((p) => (p as { endpoint_id?: string }).endpoint_id === endpoint) ?? body.prices?.[0];
      if (entry && typeof entry.unit_price === "number") {
        price = { unit_price: entry.unit_price, unit: entry.unit, currency: entry.currency ?? "USD" };
      }
    } else {
      console.warn(`fal pricing API ${res.status} pour ${endpoint}`);
    }
  } catch (err) {
    console.warn(`fal pricing API indisponible pour ${endpoint} :`, err instanceof Error ? err.message : err);
  }
  cache.set(endpoint, { at: Date.now(), price });
  return price;
}

export async function estimateCost(model: VideoModel, options: Options): Promise<CostEstimate> {
  const billedSeconds = model.billedSeconds(options);
  const usd = model.estimateUsd(options);
  // L'API de tarifs de fal ne connaît que les endpoints fal : pour un modèle
  // BytePlus, « endpoint » est un id ModelArk et l'appel répondrait 400.
  const live = model.provider === "byteplus" ? null : await fetchLiveUnitPrice(model.endpoint);
  const estimate: CostEstimate = { usd, billedSeconds };
  if (live) {
    estimate.live = live;
    // fal ne renvoie qu'un tarif de base par endpoint : on ne s'en sert pour chiffrer
    // que si le prix du modèle ne dépend pas des options (résolution, audio…).
    if (!model.rateDependsOnOptions) {
      if (/second/i.test(live.unit)) {
        estimate.liveUsd = live.unit_price * billedSeconds;
      } else if (/video/i.test(live.unit)) {
        estimate.liveUsd = live.unit_price;
      }
    } else if (model.rateMultiplier && /second/i.test(live.unit)) {
      // Le tarif dépend du palier, mais on sait relier le prix de base renvoyé
      // par fal au palier choisi : on chiffre sur le prix RÉEL. C'est ce qui
      // permet de suivre une promo sans redéployer (constaté : H3 Max facturé
      // 0,0125 $/s au lieu de 0,05 pendant une remise de 75 %).
      estimate.liveUsd = live.unit_price * billedSeconds * model.rateMultiplier(options);
    }
  }
  return estimate;
}

export function formatUsd(n: number): string {
  return `${n.toFixed(2)} $`;
}
