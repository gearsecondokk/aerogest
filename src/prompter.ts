import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { config } from "./config.js";
import { describeOptions, type Options, type VideoModel } from "./models.js";
import type { Proposal } from "./store.js";

const client = new Anthropic(config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : {});

const ProposalSchema = z.object({
  prompt: z.string().describe("The final video generation prompt, in English, ready to send to the model."),
  negative_prompt: z
    .string()
    .nullable()
    .describe("Negative prompt in English if the model supports one and it is useful, otherwise null."),
  explanation: z
    .string()
    .describe("Short explanation in French (2-4 sentences) of the creative choices, addressed to the user."),
  question: z
    .string()
    .nullable()
    .describe("One optional short question in French if a key detail is missing, otherwise null."),
});

const SYSTEM_PROMPT = `You are an expert prompt engineer for AI image-to-video models (Kling, Veo, Hailuo, Wan, Seedance).
You help a French-speaking user turn a rough idea plus a reference image into an excellent prompt.

Rules:
- Look carefully at the image: it will be the FIRST FRAME of the video. Your prompt must describe motion that starts from exactly this frame (same subject, framing, lighting). Never invent a different starting scene.
- Write the prompt in English, the explanation and the question in French.
- Describe: what moves and how (subject action), camera movement, pacing, atmosphere/lighting, style. Be concrete and visual, avoid vague adjectives.
- Respect the duration chosen: do not pack more action than fits in the duration.
- Keep prompts between 30 and 120 words unless the model guide says otherwise.
- Follow the model-specific guide provided by the user message.
- If the user gives feedback, revise the previous prompt accordingly instead of starting over.
- Ask at most one question, and only when a truly important detail is missing. Always still provide a usable prompt.`;

export interface ProposeArgs {
  model: VideoModel;
  options: Options;
  imageUrl: string;
  history: Anthropic.MessageParam[];
  userText: string;
}

export interface ProposeResult {
  proposal: Proposal;
  history: Anthropic.MessageParam[];
}

/**
 * Propose (ou révise) un prompt pour le modèle choisi. L'historique de la
 * conversation est renvoyé mis à jour pour permettre des allers-retours.
 */
export async function proposePrompt(args: ProposeArgs): Promise<ProposeResult> {
  const { model, options, imageUrl, userText } = args;
  const history = [...args.history];

  if (history.length === 0) {
    const context = [
      `Target model: ${model.name} (${model.endpoint}).`,
      `Model guide: ${model.promptGuide}`,
      model.options.length ? `Chosen settings: ${describeOptions(model, options)}.` : "",
      model.maxPromptChars ? `Hard limit: ${model.maxPromptChars} characters for the prompt.` : "",
      "",
      `User's idea (French, may be rough): ${userText}`,
    ]
      .filter(Boolean)
      .join("\n");

    history.push({
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: imageUrl } },
        { type: "text", text: context },
      ],
    });
  } else {
    history.push({ role: "user", content: userText });
  }

  const response = await client.messages.parse({
    model: config.CLAUDE_MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: history,
    output_config: { format: zodOutputFormat(ProposalSchema) },
  });

  if (response.stop_reason === "refusal") {
    const why = response.stop_details?.explanation ?? "contenu refusé";
    throw new Error(`Claude a refusé la demande (${why}).`);
  }

  const parsed = response.parsed_output;
  if (!parsed) {
    throw new Error("Réponse de Claude illisible (JSON invalide). Réessaie.");
  }

  let prompt = parsed.prompt.trim();
  if (model.maxPromptChars && prompt.length > model.maxPromptChars) {
    prompt = prompt.slice(0, model.maxPromptChars);
  }

  const proposal: Proposal = {
    prompt,
    negative_prompt: parsed.negative_prompt?.trim() || null,
    explanation: parsed.explanation.trim(),
    question: parsed.question?.trim() || null,
  };

  // On garde la réponse structurée telle quelle dans l'historique pour les révisions.
  history.push({ role: "assistant", content: JSON.stringify(proposal) });

  return { proposal, history };
}

export function describeClaudeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Clé API Anthropic invalide (ANTHROPIC_API_KEY).";
  if (err instanceof Anthropic.RateLimitError) return "Claude est saturé (rate limit), réessaie dans un instant.";
  if (err instanceof Anthropic.APIError) return `Erreur Claude ${err.status ?? ""}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
