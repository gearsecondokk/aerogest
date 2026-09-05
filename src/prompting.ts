/**
 * Base de connaissances : prompting vidéo IA réaliste.
 *
 * Objectif du bot : produire du contenu TikTok / Reels de modèle féminin qui
 * passe pour une vraie captation téléphone, pas pour une pub de cosmétique.
 *
 * Sources (relevées le 2026-09-05) : guides officiels et guides de référence
 * de Wan 2.5, MiniMax Hailuo 02/H3, Seedance 1.0 pro (BytePlus), Kling 2.5,
 * Veo 3.1 (Google Cloud), Seedream 4.5, Grok Imagine.
 */

export const REALISM_PLAYBOOK = `
════════ DOCTRINE DU RÉALISME ════════
Le défaut nº1 d'une vidéo IA n'est pas la résolution, c'est la PERFECTION.
Une vraie vidéo de téléphone est légèrement imparfaite. Ce qui trahit l'IA :
peau lissée sans pores, lumière de studio impeccable, mouvement trop fluide et
ralenti, symétrie parfaite, dents trop blanches, cheveux sans mèches folles,
arrière-plan trop propre, cadrage trop bien composé.

Chaque prompt doit donc VOLONTAIREMENT réintroduire du défaut :

PEAU ET VISAGE (le plus important, c'est là que l'œil détecte le faux)
  visible skin pores, fine lines, uneven skin tone, subtle blemishes,
  natural oil sheen on forehead and nose, slight under-eye shadow,
  faint freckles, no beauty retouching, no skin smoothing
CHEVEUX
  individual strands, flyaway hairs, slight frizz, natural movement with
  head motion, strands falling across the face
CAMÉRA (imiter un téléphone, PAS du cinéma)
  handheld phone camera, subtle natural shake, slight sensor noise,
  natural white balance, mild lens softness at the edges, no color grading,
  vertical 9:16 framing
LUMIÈRE (réelle, pas construite)
  window daylight, overcast soft light, bathroom mirror light, car interior
  light, golden hour through a window, mixed indoor lighting with slight
  color cast — jamais "studio lighting", "beauty dish", "rim light".
MOUVEMENT (micro > macro)
  Le réalisme vient des MICRO-mouvements : respiration visible, clignements
  irréguliers, léger transfert de poids, main qui replace une mèche, tissu
  qui suit le corps avec inertie, regard qui dévie une fraction de seconde.
  Une vidéo où le sujet fait UN geste simple et naturel bat toujours une
  vidéo où il fait trois actions spectaculaires.

À BANNIR dans les prompts (c'est ce qui fabrique le look IA) :
  cinematic, hyperrealistic, 8K, ultra detailed, masterpiece, perfect skin,
  flawless, glamour, professional studio lighting, slow motion dreamy,
  ethereal glow. Ces mots poussent le modèle vers l'esthétique publicitaire.

════════ FORMAT TIKTOK / REELS ════════
- Vertical 9:16 quand le modèle le permet, sinon cadrer serré.
- 5 s suffisent pour un plan ; 10 s seulement si l'action a une progression.
- L'accroche se joue dans la première demi-seconde : le sujet doit DÉJÀ être
  en mouvement à l'image 1, pas démarrer après une pause.
- Un plan = une action. Enchaîner plusieurs plans courts vaut mieux qu'un
  plan long où le modèle invente n'importe quoi.
- TikTok et Meta imposent de signaler les contenus générés par IA — le label
  est à activer à la publication, ça ne se gère pas dans le prompt.

════════ IMAGE→VIDÉO vs RÉFÉRENCE→VIDÉO ════════
IMAGE→VIDÉO (ce que fait ce bot) : la première image EST le premier plan.
  Ne redécris JAMAIS le sujet en détail : le modèle l'a sous les yeux, et le
  redécrire crée des conflits qui font dériver le visage. Décris uniquement
  CE QUI BOUGE, COMMENT, et CE QUI RESTE STABLE.
  Formule : « [ce qui bouge dans le sujet] + [caméra] + [environnement qui
  bouge] + [rythme] », avec une mention explicite de ce qui ne change pas :
  "her face and outfit stay exactly the same".
RÉFÉRENCE→VIDÉO : plusieurs images définissent un personnage réutilisable
  d'un plan à l'autre. Là il FAUT nommer le personnage et rappeler ses traits
  invariants (couleur des yeux, coupe, morphologie) pour la cohérence entre
  clips. C'est le mode à privilégier pour une série sur un même modèle.

════════ DÉRIVES CLASSIQUES ET PARADES ════════
Visage qui morphe   → plan plus serré, moins de mouvement de tête, durée 5 s,
                      "facial features remain consistent" + negative prompt
                      "face distortion, morphing, warping".
Mains déformées     → garder les mains hors champ ou immobiles ; ne jamais
                      demander un geste fin (compter, écrire, manipuler).
Dents               → éviter le sourire large bouche ouverte ; "closed-lip
                      smile" est beaucoup plus sûr.
Arrière-plan qui coule → "static background", caméra fixe, éviter les foules.
Vêtement qui change → "same outfit throughout", éviter les motifs complexes.
Marche              → la démarche est le point faible de tous les modèles :
                      préférer un mouvement sur place, un demi-tour lent, ou
                      un plan buste.

════════ NEGATIVE PROMPTS ════════
Base réutilisable (Wan, Kling, Hailuo, Seedance) :
  "plastic skin, smooth airbrushed skin, beauty filter, face morphing,
   distorted hands, extra fingers, warped background, flickering, jitter,
   motion blur, oversaturated colors, studio lighting, watermark, text"
⚠️ Grok Imagine IGNORE les negative prompts : tout doit y être formulé en
positif ("clear natural skin" au lieu de "no blemishes").
`;

export const MODEL_PLAYBOOK = `
════════ SPÉCIFICITÉS PAR MODÈLE ════════

WAN 3.0 — DOC OFFICIELLE ALIBABA (source primaire, réf. API du 2026-09-04)
  ⚠️ Doc de l'API Alibaba directe (media[].type, ratio, prompt_extend). Sur fal
  les paramètres sont normalisés (start_image_url, resolution, duration, audio) —
  seuls les conseils de RÉDACTION se transposent.

  Deux variantes : wan3.0-video (standard) et wan3.0-video-prime (rapide, mêmes
  capacités) — c'est cette dernière que fal expose en reference-to-video.

  Prompt : jusqu'à 20 000 caractères, anglais ou chinois, tronqué au-delà. Ce
  n'est PAS une invitation à écrire long : un prompt court et précis reste
  meilleur, la limite sert aux découpages plan par plan.

  ⚠️ prompt_extend est activé PAR DÉFAUT : un LLM réécrit le prompt avant
  génération. Ça sauve les prompts courts, mais ça peut aussi défaire une
  formulation travaillée — typiquement réintroduire l'esthétique publicitaire
  qu'on cherche justement à éviter. Si un rendu réaliste soigné part en "beau
  plan de pub", c'est le premier suspect.

  Références (mode reference-to-video) — limites RÉELLES, plus serrées que
  Seedance : 10 images de référence max, 5 vidéos (15 s cumulées), 5 audios
  (15 s cumulées). Première/dernière image : 1 chacune.
  Désignation dans le prompt : "Image 1", "Video 1", "Audio 1" selon l'ordre
  d'envoi. Les compteurs sont SÉPARÉS par type : Image 1 et Video 1 coexistent.

  Le mode première/dernière image n'accepte PAS d'audio. Pour une génération
  pilotée par le son, passer par le mode référence (images + audio).

  Paramètres : resolution 480P/720P/1080P · ratio adaptive (défaut) ou
  16:9 / 4:3 / 1:1 / 3:4 / 9:16 · duration 2 à 30 s, ou -1 pour laisser le
  modèle choisir · audio activé par défaut, et il NE CHANGE PAS le prix.

WAN 2.5 — structure en 4 blocs, dans cet ordre :
  1. mouvement du sujet  2. mouvement de caméra  3. environnement  4. rythme
  Le modèle lit le DÉBUT du prompt avec le plus d'attention : mettre l'action
  du sujet en premier. Garder la caméra quasi immobile. Le negative_prompt
  (500 car. max) est indispensable, c'est lui qui tient la qualité.
  Prompt jusqu'à 1500 car., expansion activée côté modèle → rester naturel.

MINIMAX H3 — DOC OFFICIELLE MINIMAX (source primaire, API v2)
  ⚠️ Doc de l'API MiniMax directe (content[] avec role). Sur fal les paramètres
  sont normalisés — seuls les conseils de RÉDACTION se transposent.

  DEUX MODÈLES, ET ILS N'ONT PAS LES MÊMES CAPACITÉS :
    MiniMax-H3      : texte→vidéo, image→vidéo ET référence→vidéo.
                      768P ou 2K. Durée 4 à 15 s.
    MiniMax-H3-Max  : variante RAPIDE. Texte→vidéo et image→vidéo SEULEMENT.
                      La doc dit explicitement que référence→vidéo n'est PAS
                      supporté. 480P ou 768P (pas de 2K). Durée 5 à 15 s
                      (4 s indisponible).
  ⚠️ fal expose pourtant un endpoint minimax/h3-max/reference-to-video, qui
  accepte reference_image_urls à la validation. Il route probablement vers H3.
  Contradiction NON tranchée : à vérifier par une vraie génération.

  Modes mutuellement exclusifs : on ne mélange PAS première/dernière image et
  références dans la même requête. C'est l'un ou l'autre.

  Limites de références : 9 images max · 3 vidéos (2 à 15 s chacune, 15 s
  cumulées) · 3 audios (mêmes bornes). Images : 256 à 5760 px de côté, rapport
  d'aspect entre 0,4 et 2,5, 30 Mo max. Corps de requête total ≤ 64 Mo.

  Format d'image : le rapport 0,4-2,5 couvre le 9:16 (0,5625) — donc le format
  TikTok passe, mais une image plus étroite que 0,4 est refusée.

  Ratio de sortie : en image→vidéo il est TOUJOURS adaptatif (hérité de l'image
  d'entrée) — passer une autre valeur ne déclenche pas d'erreur, elle est
  ignorée. Pour imposer un cadrage, c'est l'image d'entrée qui décide.

  Rédaction (recoupé) : trois blocs — sujet + action, direction de caméra,
  ambiance. UNE SEULE instruction de caméra dominante par plan ; empiler zoom,
  orbite et panoramique est la première cause d'échec. Caméra en langage de
  tournage naturel, pas en mots-clés. En image→vidéo, préciser ce qui reste
  STABLE autant que ce qui bouge.

MINIMAX HAILUO (02 / H3) — trois blocs : sujet+action, direction caméra,
  ambiance. UNE SEULE instruction de caméra dominante par plan : soit un plan
  fixe, soit un lent travelling avant. Empiler zoom + orbite + panoramique est
  la première cause d'échec. Écrire la caméra en langage de tournage naturel
  ("slowly dolly toward her at eye level"), pas en mots-clés. En i2v, préciser
  ce qui reste STABLE autant que ce qui bouge.

SEEDANCE 2.5 — DOC OFFICIELLE BYTEPLUS (source primaire, 2026-09-05)
  ⚠️ Cette doc décrit l'API ByteDance directe (content.role, ratio, duration=-1).
  Sur fal les PARAMÈTRES diffèrent (image_urls, resolution, duration) — seuls
  les conseils de RÉDACTION du prompt se transposent.

  Structure officielle en 3 temps :
   1. Résumé en une phrase :
        Sujet + Lieu + Événement + Genre/Style + Mouvement de caméra
   2. Description détaillée : découper en segments, par horodatage ("0-3s : …",
      "[1s-4s] …") ou par plans ("Shot 1: [Wide shot, locked-off camera,
      eye-level] …"). Décrire pour chacun : visuel, caméra, action, dialogue, son.
   3. Notes finales : ce qui doit rester CONSTANT — angle, mouvement, décor,
      ambiance, son.

  Horodatages : unité = la seconde entière. Intervalles CONTINUS, sans trou
  ("0-3s… 3-7s…", jamais "0-3s… 5-6s…"). Trop peu de contenu sur un intervalle
  et le modèle improvise ; trop et il coupe ou saute des morceaux. Ne pas s'en
  servir pour des gestes à haute fréquence ("secouer la tête 3 fois par seconde").
  Variantes acceptées : point précis ("à 5 s, transition rapide vers la gauche")
  et temps relatif ("après 3 secondes, tout le monde…").

  Contrôle négatif : la doc ne l'autorise QUE sur les sous-titres et l'audio.
    "No subtitles." · "No BGM; generate only environmental sounds."
  Tout le reste doit être formulé en POSITIF.

  Vocabulaire caméra officiel — utilisable tel quel :
    tailles : extreme wide shot / wide shot / medium shot / medium close-up / close-up
    mouvements : push in / pull out / pan / track / follow / orbit / dive /
                 pull back / tilt up / handheld shake
    angles : low angle / overhead shot / first-person perspective
    techniques : one-shot (long take) / dolly zoom (Hitchcock) / aerial / FPV /
                 bullet time / handheld / speed ramp
  Pour un terme trop technique, l'écrire en [terme + explication] :
    "Rack focus: the focus shifts smoothly; the foreground trees blur while the
     character behind gradually becomes sharp."

  Actions : privilégier les descriptions GÉNÉRALES ; ne détailler que deux ou
  trois gestes marquants, sans les répéter. Expressions : phrases descriptives,
  pas d'expressions toutes faites.

  Références (mode reference-to-video) : jusqu'à 50 entrées — 30 images max
  (4K), 10 vidéos et 10 audios (30 s cumulées chacun). 1 à 8 sujets par image
  donnent les meilleurs résultats. Il faut LIER explicitement chaque asset dans
  le texte, en suivant l'ordre d'envoi :
    "Images 1-2 sont le personnage 1 et correspondent à l'audio 1 ;
     images 3-4 le personnage 2…"
  ⚠️ Ne PAS se contenter d'écrire le nom du personnage sur l'image elle-même :
  la doc prévient que ça mélange ou duplique les personnages.
  Quand une référence se suffit à elle-même, dire simplement de s'y référer au
  lieu de redécrire la scène en détail.

  🎯 FORMULE DE RÉALISME TIRÉE DE LA DOC (exemple officiel, à reprendre) :
    "Domestic realistic short drama, shot on Arri Alexa Mini LF, 35 mm cinema
     lens, cinematic realistic lighting, film grain, authentic skin texture,
     natural lifelike performance, subtle micro-expressions, real adult facial
     bone structure and facial features, no excessive beautification or skin
     smoothing."
  Elle confirme la doctrine ci-dessus : c'est ByteDance elle-même qui demande
  d'exclure le lissage et l'embellissement pour obtenir du réaliste.

SEEDANCE 1.0 PRO — le plus obéissant sur le vocabulaire de tournage. Comprend
  les tailles de plan (long shot, full shot, medium shot, close-up) et les
  mouvements nommés (tracking shot, pan left/right, truck left/right), et sait
  en enchaîner plusieurs dans un même plan. Angles : high-angle, low-angle,
  aerial, macro. C'est le modèle à choisir quand le cadrage compte.

KLING 2.5 TURBO — formule officielle :
  Sujet + Mouvement du sujet + Décor + (Langage caméra + Lumière + Ambiance)
  Cap technique à 2500 car. mais un prompt de 60 à 100 mots donne de MEILLEURS
  résultats qu'un prompt saturé. Très bon sur la physique des tissus et
  cheveux. Negative prompt supporté et recommandé.

VEO 3.1 — cinq éléments : sujet, action, décor, style, AUDIO. Seul modèle du
  catalogue à générer le son. Clips ~8 s : les répliques doivent tenir en une
  respiration. Syntaxe de dialogue :
    [description du personnage] says: "la réplique exacte" (no subtitles)
  Le "(no subtitles)" évite les sous-titres incrustés. Ne pas empiler les
  mouvements de caméra, il les suit trop littéralement.

════════ FABRIQUER L'IMAGE DE DÉPART ════════
Ces outils ne sont pas appelés par le bot, mais c'est eux qui produisent la
photo qu'on anime ensuite. La qualité de la vidéo est plafonnée par celle de
cette image : un visage plastique en entrée donne une vidéo plastique.

SEEDREAM 4.5 / DREAMINA (ByteDance) — structure en 5 blocs : sujet, style,
  composition, lumière et atmosphère, paramètres techniques. Excellent sur la
  peau et les cheveux. Pas besoin d'empiler les mots-clés, une phrase bien
  structurée suffit. Exemple de socle photoréaliste :
    "A young woman in soft window light, photorealistic, 85mm lens, shallow
     depth of field, visible skin pores and fine texture, natural expression"
GROK IMAGINE (xAI) — prompt en langage naturel de 30 à 80 mots, comme un
  brief à un photographe. Structure : sujet + décor + style + détails
  techniques. IGNORE les negative prompts → tout formuler en positif.

Conseil transverse : pour une série sur le MÊME modèle, générer une fois un
jeu d'images de référence (face, 3/4, profil, plan large) et les réutiliser,
plutôt que de regénérer un visage à chaque fois — sinon le personnage change
d'un post à l'autre et l'illusion tombe.
`;
