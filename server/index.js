import { config as loadEnv } from "dotenv";
import express from "express";
import * as cheerio from "cheerio";
import { adjustRecipe } from "./adjustRecipe.js";

// .env.local (gitignored, personal secrets) takes precedence over .env
// (shared/example defaults) — dotenv only sets vars not already present in
// process.env, so loading .env.local first means it wins. (adjustRecipe.js
// also loads env itself, before it, since it reads ANTHROPIC_API_KEY at its
// own module-evaluation time — that happens as part of the import above,
// before this line runs, so it can't rely on this call.)
loadEnv({ path: ".env.local" });
loadEnv();

const PORT = process.env.PORT || 5174;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 5_000_000;
const MIN_TEXT_LEN = 40;
const MIN_EXTRACTED_LEN = 120;

// Loose signal that a block of text is actually a recipe, not just any
// paragraph of text — used both for pasted text and for whatever we scrape
// off a page. Not meant to be precise; the AI rewrite step downstream does
// the real understanding, this just filters out obvious non-recipes.
const RECIPE_HINTS =
  /\b(ingredient|ingredients|cup|cups|tsp|tbsp|teaspoon|tablespoon|oz|ounce|gram|grams|ml|minute|minutes|hour|hours|bake|boil|simmer|whisk|preheat|oven|stir|chop|dice|mince|recipe|serving|servings|yield)\b/i;

function looksLikeRecipe(text) {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LEN) return false;
  const lines = trimmed.split(/\n+/).filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;
  return RECIPE_HINTS.test(trimmed);
}

function cleanWhitespace(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// Simple readability-style extraction: strip the obvious chrome (scripts,
// nav, ads-shaped containers, etc.), turn block-level tags into line breaks,
// then prefer a recipe-shaped container if one is findable, else fall back
// to the whole body. Doesn't need to be perfect — the AI step cleans up
// whatever this returns.
function extractReadableText(html) {
  const $ = cheerio.load(html);
  $(
    "script, style, noscript, nav, header, footer, aside, form, iframe, svg, button, template, [aria-hidden='true']"
  ).remove();
  $("br").replaceWith("\n");
  $("p, li, h1, h2, h3, h4, h5, h6, tr, blockquote").each((_, el) => {
    $(el).append("\n");
  });

  const candidateSelectors = [
    "[itemprop='recipeInstructions']",
    "[class*='recipe' i]",
    "[id*='recipe' i]",
    "article",
    "main",
  ];
  let root = null;
  for (const selector of candidateSelectors) {
    const found = $(selector).first();
    if (found.length && found.text().trim().length >= MIN_EXTRACTED_LEN) {
      root = found;
      break;
    }
  }
  if (!root) root = $("body");

  return cleanWhitespace(root.text());
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RecipeSwapBot/1.0; +https://recipeswap.local)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const app = express();
app.use(express.json({ limit: "200kb" }));

app.post("/api/ingest-recipe", async (req, res) => {
  const { recipeInput, inputMode } = req.body ?? {};

  if (typeof recipeInput !== "string" || !recipeInput.trim()) {
    return res.status(400).json({ error: "Paste a recipe or a link first." });
  }
  if (inputMode !== "text" && inputMode !== "url") {
    return res.status(400).json({ error: "Unknown input mode." });
  }

  if (inputMode === "text") {
    const trimmed = recipeInput.trim();
    if (!looksLikeRecipe(trimmed)) {
      return res.status(422).json({
        error: "That doesn't look like a full recipe yet — paste the ingredients and steps.",
      });
    }
    return res.json({ text: trimmed, source: "text", charCount: trimmed.length });
  }

  // inputMode === "url"
  let url;
  try {
    url = new URL(recipeInput.trim());
  } catch {
    return res.status(400).json({ error: "That's not a valid URL." });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return res.status(400).json({ error: "Only http and https links are supported." });
  }

  let response;
  try {
    response = await fetchPage(url);
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "That page took too long to load. Try again." });
    }
    return res.status(502).json({ error: "We couldn't reach that page. Check the link and try again." });
  }

  if (!response.ok) {
    return res.status(502).json({ error: `That page returned an error (${response.status}).` });
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return res.status(422).json({ error: "That link doesn't point to a readable web page." });
  }

  let html;
  try {
    html = await response.text();
  } catch {
    return res.status(502).json({ error: "We couldn't read that page's contents." });
  }
  if (html.length > MAX_HTML_BYTES) {
    html = html.slice(0, MAX_HTML_BYTES);
  }

  let extracted;
  try {
    extracted = extractReadableText(html);
  } catch {
    return res.status(500).json({ error: "Something went wrong reading that page." });
  }

  if (!looksLikeRecipe(extracted)) {
    return res.status(422).json({ error: "We couldn't find a recipe on that page." });
  }

  return res.json({
    text: extracted,
    source: "url",
    sourceUrl: url.toString(),
    charCount: extracted.length,
  });
});

app.post("/api/adjust-recipe", async (req, res) => {
  const { recipeText, dietaryRestrictions, preferences } = req.body ?? {};

  if (typeof recipeText !== "string" || !recipeText.trim()) {
    return res.status(400).json({ error: "recipeText is required." });
  }
  if (!looksLikeRecipe(recipeText)) {
    return res.status(400).json({ error: "That recipe text looks too short or malformed to adjust." });
  }

  const diets = Array.isArray(dietaryRestrictions) ? dietaryRestrictions.filter((d) => typeof d === "string") : [];
  const prefs = Array.isArray(preferences)
    ? preferences.filter((p) => typeof p === "string")
    : typeof preferences === "string"
    ? preferences
    : [];

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }

  try {
    const result = await adjustRecipe({ recipeText: recipeText.trim(), dietaryRestrictions: diets, preferences: prefs });
    return res.json(result);
  } catch (err) {
    if (err.name === "ClaudeParseError") {
      console.error("Claude returned malformed JSON twice:", err.raw);
      return res.status(502).json({ error: "The AI returned a response we couldn't parse. Please try again." });
    }
    if (err.name === "ClaudeUpstreamError") {
      console.error(err);
      return res.status(502).json({ error: "We couldn't reach the AI service. Please try again." });
    }
    console.error(err);
    return res.status(500).json({ error: "Something went wrong adjusting that recipe." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.listen(PORT, () => {
  console.log(`Recipe Swap API listening on http://localhost:${PORT}`);
});
