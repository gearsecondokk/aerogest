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

AMATEUR OBLIGATOIRE — VÉRIFIÉ PAR LE CODE À CHAQUE PROPOSITION
  La consigne de l'utilisateur, mot pour mot : « filmé de manière un peu
  amateur, pour que ça ne fasse pas trop parfait ». Un prompt est REFUSÉ
  (et tu le corriges) s'il ne contient pas : (1) le téléphone tenu à la main
  (« filmed by a friend on a phone, handheld »), (2) la peau réelle (« visible
  pores, uneven skin, unretouched »), (3) au moins DEUX défauts amateur
  concrets — cadrage un peu décentré ou penché, autofocus qui cherche une
  seconde, flou de mouvement quand elle bouge, hautes lumières brûlées par la
  fenêtre, bruit de capteur, caméra qui bouge — et s'il contient UN mot du
  registre cinéma/pub : cinematic, lens flare, haze, dreamy, ethereal, bokeh,
  film look, color graded, editorial, slow motion, glow, sun-kissed, glamour,
  dolly, cinema lens. « Golden hour » désigne une heure, pas un look : on écrit
  « late afternoon sun, harsh on one side of her face », jamais « warm haze,
  lens flare, orange glow ».
  Phrase prête à coller en fin de prompt vidéo : « Filmed by a friend on a
  phone, handheld and a bit unsteady, framing slightly off-center, autofocus
  hunting for a moment, brief motion blur when she moves, highlights blown out
  by the window, mild sensor noise, no color grading, natural skin with visible
  pores. » Les gestes aussi doivent être imparfaits : un pas raté, le sac qui
  glisse, un regard hors champ, un rire mal cadré.

AUDIO — JAMAIS DE MUSIQUE DE FOND (règle de l'utilisateur, vérifiée par le code)
  Les modèles à audio natif (Seedance, Wan 3.0, Kling avec generate_audio,
  Veo, H3) ajoutent une musique si on ne l'interdit pas. Chaque prompt vidéo
  finit donc par une interdiction explicite : « No background music — only
  ambient sound (street, wind, room tone) and her voice. » Sur Seedance, la
  formulation officielle : « No BGM; generate only environmental sounds. »
  Dans le negative prompt : « background music, soundtrack, music ». Un
  prompt qui demande une musique, ou qui oublie de l'interdire, est refusé.
  La musique ou la voix off, c'est au montage, avec un son TikTok — jamais
  générée.

PEAU ET VISAGE (le plus important, c'est là que l'œil détecte le faux)
  visible skin pores, fine lines, uneven skin tone, subtle blemishes,
  natural oil sheen on forehead and nose, slight under-eye shadow,
  faint freckles, no beauty retouching, no skin smoothing
CHEVEUX
  individual strands, flyaway hairs, slight frizz, natural movement with
  head motion, strands falling across the face
CAMÉRA (un téléphone tenu par quelqu'un, PAS du cinéma)
  filmed by a friend on a phone, handheld and unsteady, framing slightly
  off-center, autofocus hunting briefly, brief motion blur, mild sensor noise,
  no color grading, vertical 9:16 framing. Pas de « dolly », « tracking shot »,
  « orbit » : quelqu'un marche avec le téléphone, c'est tout.
LUMIÈRE (réelle, pas construite)
  window daylight, overcast soft light, bathroom mirror light, car interior
  light, golden hour through a window, mixed indoor lighting with slight
  color cast — jamais "studio lighting", "beauty dish", "rim light".
  La lumière réelle est souvent RATÉE : contre-jour qui brûle la fenêtre,
  visage à moitié dans l'ombre, néon verdâtre — c'est ce qui fait vrai.
MOUVEMENT (micro > macro)
  Le réalisme vient des MICRO-mouvements : respiration visible, clignements
  irréguliers, léger transfert de poids, main qui replace une mèche, tissu
  qui suit le corps avec inertie, regard qui dévie une fraction de seconde.
  Une vidéo où le sujet fait UN geste simple et naturel bat toujours une
  vidéo où il fait trois actions spectaculaires.

À BANNIR dans les prompts (c'est ce qui fabrique le look IA) :
  cinematic, hyperrealistic, 8K, ultra detailed, masterpiece, perfect skin,
  flawless, glamour, professional studio lighting, slow motion, dreamy,
  ethereal, glow, lens flare, haze, bokeh, film look, color graded, editorial,
  sun-kissed, dolly, cinema lens. Ces mots poussent le modèle vers
  l'esthétique publicitaire — et le code les refuse.

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
   oversaturated colors, studio lighting, cinematic, color graded, film look,
   perfect symmetry, background music, soundtrack, music, watermark, text"
  (pas de « motion blur » dans le négatif : un peu de flou de mouvement fait
  précisément partie du réalisme recherché)
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
  ("someone walks a little closer with the phone at eye level"), pas en mots-clés. En i2v, préciser
  ce qui reste STABLE autant que ce qui bouge.

SEEDANCE 2.5 — DOC OFFICIELLE BYTEPLUS (source primaire, 2026-09-05)
  ⚠️ Cette doc décrit l'API ByteDance directe (content.role, ratio, duration=-1).
  Sur fal les PARAMÈTRES diffèrent (image_urls, resolution, duration) — seuls
  les conseils de RÉDACTION du prompt se transposent.

  Structure officielle en 3 temps :
   1. Résumé en une phrase :
        Sujet + Lieu + Événement + Genre/Style + Mouvement de caméra
        (Genre/Style = « candid phone footage, UGC », jamais « short drama »
        ni « cinematic » ; caméra = « handheld phone », jamais « dolly »)
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

/**
 * Images fixes pour Instagram (posts, carrousels, stories). Même doctrine de
 * réalisme que la vidéo ; ce qui change, c'est le format, la cohérence du
 * personnage d'un post à l'autre, et la syntaxe propre à chaque modèle.
 */
export const IMAGE_PLAYBOOK = `
IMAGES POUR INSTAGRAM — DOCTRINE
- Format : le feed se publie en 4:5 (1080×1350), c'est le défaut. 1:1 acceptable, 9:16 pour les stories
  et les couvertures de Reels. Quand un modèle n'a pas de 4:5 (Seedream, Grok), prendre 3:4 : Instagram
  recadre à peine. Générer en 2K pour publier (Instagram recompresse, il faut de la marge), en 1K pour
  dégrossir un duel — c'est 2 à 4 fois moins cher.
- Réalisme photo, mêmes règles qu'en vidéo : rendu téléphone (iPhone, 26 mm, f/1.8), lumière existante
  et imparfaite, peau avec pores, brillances et petites irrégularités, cheveux avec des mèches folles,
  décor vivant et un peu encombré, pose prise sur le vif, grain léger, jamais de mot du registre
  publicitaire (cinematic, 8K, flawless, perfect, studio lighting, beauty retouch). Écrire « unretouched
  phone photo » vaut mieux que « photorealistic ».
- COHÉRENCE DU PERSONNAGE : pour refaire le MÊME mannequin dans un nouveau post, on ne part jamais du
  texte seul — on passe par un modèle d'ÉDITION avec 2 à 4 références de la même personne (un gros plan
  du visage + un plein pied). Dans le prompt, on ne redécrit PAS le visage (ça le fait dériver) : on
  ancre « the same woman as in the reference images, identical face, hair and skin tone », puis on décrit
  ce qui CHANGE — tenue, lieu, lumière, pose, cadrage.
- Créer un NOUVEAU personnage se fait en texte→image : fixer son identité une fois avec des ancres
  distinctives (taches de rousseur, frange, couleur des yeux, morphologie), générer plusieurs variantes,
  garder la meilleure comme référence pour tout ce qui suit.
- Carrousel : mêmes références, même lumière, même tenue ; on ne fait varier que la pose et l'angle.
- Les duels d'images coûtent des centimes : ici on peut comparer 4 modèles d'un coup sans hésiter, et
  c'est le bon moment pour trancher entre les familles avant de produire en volume.

SYNTAXE PAR MODÈLE (IMAGE)
- Nano Banana Pro / Nano Banana 2 (Google, fal) : phrases complètes, ton conversationnel, dire
  explicitement ce qui doit rester identique (« keep her face exactly as in the references »). Le plus
  fiable du catalogue pour tenir un visage en édition. Le 4:5 est natif.
- GPT Image 2 (OpenAI, fal) : langage naturel détaillé, suit très bien les consignes et le texte dans
  l'image. Qualité « high » pour publier, « medium » pour dégrossir (4 fois moins cher).
- Seedream 4.5 (fal) et Seedream 5.0 Pro (TopView) : description naturelle + termes photo (focale,
  lumière). En édition, désigner les références par « the woman in image 1 ». Pas de 4:5 → 3:4. Rendu
  peau très crédible. Au test du 2026-09-05, l'édition Seedream sur fal a accepté la mannequin
  (contrairement à Seedance en vidéo) ; en cas de refus, la route TopView prend le relais.
- FLUX 2 Max (Black Forest Labs, fal) : prompt descriptif structuré — sujet, décor, lumière, appareil,
  ambiance — le plus photographique sur la peau et les textures. Facturé au mégapixel : le 2K coûte 3 fois
  le 1K.
- Grok Imagine Image (xAI, fal) : prompts courts, rendu candide très naturel, le moins cher du catalogue —
  parfait pour le volume et les brouillons. Pas de 4:5 → 3:4. Édition limitée à 3 références.
- Midjourney v8.1 (TopView) : la référence esthétique, mais il embellit — le brider avec « candid
  unretouched phone photo, natural skin texture ». Édition limitée à 4 références. Les paramètres
  --style ou --ar dans le prompt ne sont pas garantis via TopView : le format se règle par l'option.
`;
