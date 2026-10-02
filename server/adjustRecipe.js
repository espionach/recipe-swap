import { config as loadEnv } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

// This module reads process.env below at module-evaluation time (to build
// `client`), which happens as soon as something imports this file — before
// any top-level code in the importer runs. So env loading has to happen
// here, not rely on the importer having loaded it first.
// .env.local (gitignored, personal secrets) takes precedence over .env.
loadEnv({ path: ".env.local" });
loadEnv();

// NOTE: "claude-sonnet-4-6" was the model name requested for this feature.
// It is not a model ID this build recognizes as current — override via
// CLAUDE_MODEL if the API rejects it (e.g. "claude-sonnet-5").
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const MAX_TOKENS = 4096;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});

const SYSTEM_PROMPT = `You are a recipe adaptation engine. You rewrite recipes to satisfy dietary restrictions and taste/texture preferences while keeping the recipe fully functional as a recipe — correct ratios, correct method, nothing broken or forgotten.

Given an original recipe, a list of dietary restrictions, and a list of taste/texture preferences, you must:

1. Identify the recipe's name (a short, natural dish title) and parse the original recipe into structured ingredients (name, quantity, unit) and a sequence of method steps, exactly as originally written — this is the "original" side of a before/after comparison, so do not adjust it.

2. Apply every dietary restriction as an ingredient substitution appropriate to this specific dish — not a generic swap. For example: butter -> vegan butter or a neutral oil for dairy-free/vegan (pick whichever suits the dish's texture); wheat flour -> a 1:1 gluten-free flour blend for gluten-free; egg -> a flax egg (1 tbsp ground flaxseed + 3 tbsp water per egg, rested 5 minutes) or unsweetened applesauce for egg-free, chosen based on what role the egg plays in THIS recipe (binding vs. leavening vs. moisture — a flax egg binds, applesauce adds moisture but little structure).

3. Apply every taste/texture preference by adjusting ratios, not just relabeling — e.g. "chewier" -> more brown sugar relative to white sugar, less baking soda, slightly shorter bake time; "crispier" -> more white sugar relative to brown, slightly longer bake, lower hydration; "richer" -> more fat and/or egg yolks; "less sweet" -> reduce sugar and compensate elsewhere for lost moisture/browning if needed; "less fatty" -> reduce butter/oil and compensate with an added liquid (milk, yogurt, applesauce) to preserve moisture and texture; "spicier" -> increase or add a relevant spice/chili element appropriate to the dish's cuisine.

4. CRITICALLY, recalculate the whole recipe so it still works: if you remove or reduce an ingredient, adjust the other ingredients and/or method (added liquid, leavening, chill time, bake time, oven temperature) to compensate. Do not just swap an ingredient's name and leave the rest of the recipe as if nothing changed.

5. Output ONLY a single JSON object — no markdown code fences, no preamble, no commentary before or after it, nothing but the JSON object itself. It must have exactly this shape:

{
  "title": string,
  "originalIngredients": [ { "name": string, "quantity": string, "unit": string } ],
  "originalSteps": [ string, ... ],
  "adjustedIngredients": [ { "name": string, "quantity": string, "unit": string, "changed": boolean } ],
  "adjustedSteps": [ string, ... ],
  "changesSummary": [ string, ... ]
}

"originalIngredients"/"originalSteps" are the recipe exactly as given, unmodified, just parsed into structure. "changed" on each adjusted ingredient must be true if that ingredient was substituted, added, or had its quantity/unit changed from the original, and false if it's carried over unchanged. Every entry in changesSummary must be one sentence in the form "Changed X because Y", naming a specific substitution or ratio change and the reason for it. Do not include any text outside the JSON object — your entire response must be valid JSON and nothing else.`;

function buildUserMessage({ recipeText, dietaryRestrictions, preferences }, reinforce) {
  const dietsLine = dietaryRestrictions.length ? dietaryRestrictions.join(", ") : "none";
  const prefsLine = Array.isArray(preferences)
    ? preferences.length
      ? preferences.join(", ")
      : "none"
    : preferences || "none";

  const base = [
    "ORIGINAL RECIPE:",
    recipeText.trim(),
    "",
    "DIETARY RESTRICTIONS (must follow, no exceptions):",
    dietsLine,
    "",
    "TASTE/TEXTURE PREFERENCES (adjust ratios accordingly):",
    prefsLine,
  ].join("\n");

  return reinforce
    ? base +
        "\n\nReminder: respond with ONLY the JSON object described in the system prompt. No markdown, no code fences, no text before or after it."
    : base;
}

function extractJson(text) {
  // Strip accidental code fences in case the model wraps the JSON anyway.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(stripped);
}

function validateShape(obj) {
  if (!obj || typeof obj !== "object") throw new Error("response is not an object");
  if (!Array.isArray(obj.originalIngredients)) throw new Error("missing originalIngredients array");
  if (!Array.isArray(obj.originalSteps)) throw new Error("missing originalSteps array");
  if (!Array.isArray(obj.adjustedIngredients)) throw new Error("missing adjustedIngredients array");
  if (!Array.isArray(obj.adjustedSteps)) throw new Error("missing adjustedSteps array");
  if (!Array.isArray(obj.changesSummary)) throw new Error("missing changesSummary array");
  for (const ing of obj.originalIngredients.concat(obj.adjustedIngredients)) {
    if (!ing || typeof ing !== "object" || typeof ing.name !== "string") {
      throw new Error("malformed ingredient entry");
    }
  }
  for (const step of obj.originalSteps.concat(obj.adjustedSteps)) {
    if (typeof step !== "string") throw new Error("malformed step entry");
  }
  for (const change of obj.changesSummary) {
    if (typeof change !== "string") throw new Error("malformed entry in changesSummary");
  }
  return obj;
}

// Fills in anything the model left loose (missing title, quantity/unit as
// non-strings, "changed" not a strict boolean) so the client always gets a
// predictable shape instead of needing its own defensive coercion.
function normalize(obj) {
  const normIngredient = (ing, withChanged) => ({
    name: String(ing.name ?? "").trim(),
    quantity: ing.quantity == null ? "" : String(ing.quantity).trim(),
    unit: ing.unit == null ? "" : String(ing.unit).trim(),
    ...(withChanged ? { changed: Boolean(ing.changed) } : {}),
  });
  return {
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "Your remixed recipe",
    originalIngredients: obj.originalIngredients.map((i) => normIngredient(i, false)),
    originalSteps: obj.originalSteps.map(String),
    adjustedIngredients: obj.adjustedIngredients.map((i) => normIngredient(i, true)),
    adjustedSteps: obj.adjustedSteps.map(String),
    changesSummary: obj.changesSummary.map(String),
  };
}

async function requestOnce(input, reinforce) {
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(input, reinforce) }],
    });
  } catch (err) {
    const wrapped = new Error(`Claude API request failed: ${err.message}`);
    wrapped.name = "ClaudeUpstreamError";
    wrapped.cause = err;
    throw wrapped;
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  try {
    return normalize(validateShape(extractJson(text)));
  } catch (err) {
    const wrapped = new Error(`Claude response was not valid JSON: ${err.message}`);
    wrapped.name = "ClaudeParseError";
    wrapped.raw = text;
    throw wrapped;
  }
}

// Retries exactly once, and only for a malformed-JSON response — an upstream
// failure (network, auth, rate limit) is a different problem and retrying it
// blindly here wouldn't help, so it propagates immediately instead.
export async function adjustRecipe(input) {
  try {
    return await requestOnce(input, false);
  } catch (err) {
    if (err.name !== "ClaudeParseError") throw err;
    return await requestOnce(input, true);
  }
}
