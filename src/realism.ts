/**
 * Contrôle du réalisme AVANT toute proposition.
 *
 * Constat du 2026-09-05 sur les prompts réellement envoyés : l'agent mettait
 * bien « handheld phone camera, visible pores, sensor noise »… puis empilait à
 * côté « golden hour sunlight, warm haze, faint lens flare ». Les modèles
 * suivent le plus flatteur des deux registres : rendu de pub, trop parfait.
 * Demander ne suffit pas ; on vérifie, et on refuse avec la phrase à ajouter.
 */

export type MediaKind = "image" | "video";

/** Vocabulaire qui fabrique le look IA/publicité. Interdit, même « pour la lumière ». */
const BANNED: RegExp[] = [
  /\bcinematic\b/i, /\blens flares?\b/i, /\bhaz[ey]\b/i, /\bdreamy\b/i, /\bethereal\b/i, /\bbokeh\b/i,
  /\bfilm look\b/i, /\bcolou?r[- ]?grad(ed|ing)\b/i, /\beditorial\b/i, /\bfashion (film|shoot)\b/i,
  /\bslow[- ]?mo(tion)?\b/i, /\b8k\b/i, /\bhyper-?real/i, /\bflawless\b/i, /\bperfect (skin|light|symmetry)\b/i,
  /\bmasterpiece\b/i, /\bstudio light/i, /\bbeauty dish\b/i, /\brim light/i, /\b(golden|orange|warm|soft) glow\b/i,
  /\bsun-?kissed\b/i, /\bglamou?r(ous)?\b/i, /\bshot on (arri|red|alexa|cinema)/i, /\b35 ?mm cinema lens\b/i, /\bdolly\b/i,
];

/** Ce qu'un vrai plan de téléphone contient : au moins un marqueur par famille. */
const CAMERA = /\b(phone|iphone|handheld|hand-held|selfie|filmed by|ugc|amateur|home video|snapshot|candid)\b/i;
const SKIN = /(skin texture|pores|uneven skin|blemish|unretouched|no retouch|no beauty|natural skin|oil sheen|freckl)/i;

/** Défauts amateur concrets — chaque entrée est une famille distincte. */
const DEFECTS: Array<[string, RegExp]> = [
  ["cadrage décentré / penché", /(off-?cent(er|re)|slightly tilted|crooked|tilt(ed)? (horizon|frame)|awkward(ly)? (framed|cropped)|cuts? off)/i],
  ["autofocus qui cherche", /(autofocus|focus hunt|refocus|briefly out of focus|soft focus for a moment)/i],
  ["flou de mouvement", /(motion blur|blurr?ed (frame|hand|movement))/i],
  ["exposition ratée", /(blown[- ]out|blown highlights|over-?exposed|under-?exposed|uneven exposure|clipped highlights|too dark|too bright)/i],
  ["bruit / compression", /(sensor noise|grain|compression|artifacts?|low bitrate|noisy shadows)/i],
  ["caméra instable", /(shak(y|e)|wobbl(e|y)|unsteady|jerky|bump)/i],
  ["balance des blancs / lumière mélangée", /(white balance|colou?r cast|mixed light|fluorescent|tungsten)/i],
  ["son de téléphone", /(phone mic|ambient (sound|noise)|wind noise|traffic noise|room tone)/i],
];

const SUGGEST_VIDEO =
  "Filmed by a friend on a phone, handheld and a bit unsteady, framing slightly off-center, autofocus hunting for a moment, " +
  "brief motion blur when she moves, highlights blown out by the window, mild sensor noise, no color grading, natural skin with visible pores.";
const SUGGEST_IMAGE =
  "Candid unretouched phone snapshot, framing slightly off-center, uneven available light with a blown-out window, mild noise, " +
  "visible pores and a few stray hairs.";

/** Occurrences d'un mot banni, sauf quand il est nié juste avant
 *  (« no color grading », « not slow motion », « without lens flare ») :
 *  la négation est précisément ce qu'on veut lire. */
function bannedHits(prompt: string, re: RegExp): string[] {
  const hits: string[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of prompt.matchAll(g)) {
    const before = prompt.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
    if (/\b(no|not|without|never|avoid(ing)?|zero|non)\s+(\w+\s+)?$/i.test(before)) continue;
    hits.push(m[0]);
  }
  return hits;
}

/**
 * Renvoie null si le prompt tient la doctrine, sinon le message d'erreur à
 * rendre à l'agent (qui corrige et repropose — l'utilisateur ne voit rien).
 */
export function realismIssues(prompt: string, kind: MediaKind = "video"): string | null {
  const problems: string[] = [];
  const banned = BANNED.flatMap((re) => bannedHits(prompt, re));
  if (banned.length) problems.push(`vocabulaire cinéma/pub interdit : ${[...new Set(banned.map((b) => b.toLowerCase()))].join(", ")}`);
  if (!CAMERA.test(prompt)) problems.push("aucune mention d'un téléphone tenu à la main (phone / handheld / filmed by a friend)");
  if (!SKIN.test(prompt)) problems.push("aucune mention de peau réelle (visible pores / uneven skin / unretouched)");
  const found = DEFECTS.filter(([, re]) => re.test(prompt)).map(([name]) => name);
  const need = kind === "video" ? 2 : 1;
  if (found.length < need) {
    problems.push(
      `il faut au moins ${need} défaut${need > 1 ? "s" : ""} amateur concret${need > 1 ? "s" : ""} (${found.length} trouvé${found.length > 1 ? "s" : ""}${found.length ? " : " + found.join(", ") : ""}) — cadrage décentré, autofocus qui cherche, flou de mouvement, hautes lumières brûlées, bruit, caméra instable`,
    );
  }
  if (problems.length === 0) return null;
  return (
    `Refusé (réalisme) : ${problems.join(" ; ")}. ` +
    `La vidéo doit avoir l'air filmée par un ami avec son téléphone, pas tournée : retire les mots interdits et ajoute par exemple « ${kind === "video" ? SUGGEST_VIDEO : SUGGEST_IMAGE} », puis repropose.`
  );
}
