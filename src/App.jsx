import { useEffect, useRef, useState } from "react";
import { css } from "./css.js";
import { Hoverable } from "./Hoverable.jsx";
import whiskIcon from "./assets/whisk.png";
import whiskBowl1 from "./assets/whisk-bowl-1.png";
import whiskBowl2 from "./assets/whisk-bowl-2.png";
import {
  DIETS, TASTES, SAMPLE_RECIPE, BOLDNESS_WORDS, LOADING_STEP_LABELS, LOAD_STEPS,
  SAVED_FILTERS,
} from "./recipeData.js";
import { loadSavedRecipes, persistSavedRecipes } from "./savedRecipesStore.js";

const MIN_RECIPE_TEXT_LEN = 20;

function isLikelyUrl(value) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Gates the mix/remix flow — no screen transition and no API call happens
// unless this returns null. Mirrors inputMode the same way the rest of the
// form does, so "empty" means something different for text vs. a link.
function validateRecipeInput(recipeInput, inputMode) {
  const trimmed = recipeInput.trim();
  if (!trimmed) {
    return "Please paste a recipe or a link before continuing.";
  }
  if (inputMode === "text" && trimmed.length < MIN_RECIPE_TEXT_LEN) {
    return "That's too short to be a real recipe — paste the ingredients and steps.";
  }
  if (inputMode === "url" && !isLikelyUrl(trimmed)) {
    return "That doesn't look like a valid URL.";
  }
  return null;
}

async function fetchIngest(rawInput, mode) {
  const res = await fetch("/api/ingest-recipe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipeInput: rawInput, inputMode: mode }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong reading that recipe.");
  return data;
}

async function fetchAdjust(recipeText, dietaryRestrictions, preferences) {
  const res = await fetch("/api/adjust-recipe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipeText, dietaryRestrictions, preferences }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong adjusting that recipe.");
  return data;
}

const TAB_ON = "flex:1;border:none;border-radius:12px;padding:12px;font-size:15px;font-weight:500;background:oklch(0.925 0.016 74);color:oklch(0.26 0.022 52)";
const TAB_OFF = "flex:1;border:none;border-radius:12px;padding:12px;font-size:15px;background:transparent;color:oklch(0.55 0.02 62)";
const SEG_ON = "border:none;border-radius:99px;padding:9px 18px;font-size:14px;font-weight:500;background:oklch(0.995 0.006 82);color:oklch(0.26 0.022 52);box-shadow:0 1px 2px oklch(0.4 0.03 60 / 0.12)";
const SEG_OFF = "border:none;border-radius:99px;padding:9px 18px;font-size:14px;background:transparent;color:oklch(0.48 0.02 60)";

function chipStyle(selected) {
  return css(
    selected
      ? "border:1px solid oklch(0.55 0.14 42);background:oklch(0.55 0.14 42);color:oklch(0.985 0.01 80);border-radius:99px;padding:8px 14px;font-size:14px;line-height:1.2"
      : "border:1px solid oklch(0.89 0.018 72);background:oklch(0.985 0.008 80);color:oklch(0.36 0.02 58);border-radius:99px;padding:8px 14px;font-size:14px;line-height:1.2"
  );
}

// The single source of truth for what the user has told us about the recipe:
// what they pasted, how to interpret it, and which restrictions/preferences
// apply. Everything else in this component is screen/animation state, not
// form state, so it stays as separate hooks below.
function initialFormState() {
  return {
    recipeInput: "",
    inputMode: "text", // "text" | "url"
    dietaryRestrictions: [],
    preferences: [],
  };
}

function toggleTag(setFormState, field, label) {
  setFormState((s) => ({
    ...s,
    [field]: s[field].includes(label) ? s[field].filter((x) => x !== label) : [...s[field], label],
  }));
}

// The "something else" / "in your words" inputs don't get their own state
// slot — whatever isn't one of the predefined chip labels in the array IS
// the custom entry, so the array stays the single source of truth.
function customTagValue(list, knownLabels) {
  return list.find((x) => !knownLabels.includes(x)) ?? "";
}

function setCustomTag(setFormState, field, knownLabels, value) {
  // Check blankness on the trimmed value (so " " doesn't create a phantom
  // chip) but store the raw value — trimming the stored value on every
  // keystroke would strip a trailing space the moment you type it, making
  // it impossible to type a multi-word phrase naturally.
  const isBlank = !value.trim();
  setFormState((s) => {
    const withoutCustom = s[field].filter((x) => knownLabels.includes(x));
    return { ...s, [field]: isBlank ? withoutCustom : [...withoutCustom, value] };
  });
}

function formatIngredientLine(ing) {
  return [ing.quantity, ing.unit, ing.name].filter(Boolean).join(" ").trim();
}

function formatRecipeAsText(result) {
  const lines = [result.title, ""];
  lines.push("Ingredients:");
  result.adjustedIngredients.forEach((ing) => lines.push("- " + formatIngredientLine(ing)));
  lines.push("", "Method:");
  result.adjustedSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  return lines.join("\n");
}

// changesSummary entries are always phrased "Changed X because Y" (enforced
// server-side), so split each into a bold headline + explanation to match
// the two-line change-card layout, instead of one long run-on sentence.
function splitChangeSentence(sentence) {
  const marker = " because ";
  const idx = sentence.toLowerCase().indexOf(marker);
  if (idx === -1) return { headline: sentence, why: "" };
  return {
    headline: sentence.slice(0, idx).trim(),
    why: sentence.slice(idx + marker.length).trim(),
  };
}

export default function App() {
  const [screen, setScreen] = useState("home");
  const [formState, setFormState] = useState(initialFormState);
  const { recipeInput, inputMode, dietaryRestrictions, preferences } = formState;
  // Recipe-ingestion preview: separate from formState since it's a server
  // round-trip on top of the input, not part of the submitted form itself.
  const [ingest, setIngest] = useState({ status: "idle", text: "", error: "", charCount: 0, source: null });
  const [boldness, setBoldness] = useState(2);
  const [step, setStep] = useState(0);
  const [view, setView] = useState(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedFilter, setSavedFilter] = useState("All");
  const [alreadySaved, setAlreadySaved] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [mixError, setMixError] = useState("");
  // The real result of the last mix/remix — { title, originalIngredients,
  // originalSteps, adjustedIngredients, adjustedSteps, changesSummary }.
  // cleanedRecipeText is the ingested original text, cached so "Mix again"
  // can re-run just the adjustment step without re-ingesting.
  const [mixResult, setMixResult] = useState(null);
  const [cleanedRecipeText, setCleanedRecipeText] = useState("");

  // Saved recipes persist to localStorage — there's no backend database for
  // user content, so this is the app's actual persistence layer. Loaded once
  // on mount, written back on every change.
  const [savedRecipes, setSavedRecipes] = useState(loadSavedRecipes);
  const [viewingRecipeId, setViewingRecipeId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => {
    persistSavedRecipes(savedRecipes);
  }, [savedRecipes]);

  const copyTimeoutRef = useRef(null);

  useEffect(() => {
    return () => clearTimeout(copyTimeoutRef.current);
  }, []);

  // Full pipeline (Phase 1 ingest -> Phase 3 adjust) for the first mix.
  async function runFullMix() {
    setScreen("loading");
    setStep(0);
    setAdjustOpen(false);
    setCopied(false);
    setAlreadySaved(false);
    setJustSaved(false);
    setViewingRecipeId(null);
    setView(null);

    try {
      const ingested = await fetchIngest(recipeInput.trim(), inputMode);
      setCleanedRecipeText(ingested.text);
      setStep(1);
      const result = await fetchAdjust(ingested.text, dietaryRestrictions, preferences);
      setStep(2);
      setMixResult(result);
      await new Promise((resolve) => setTimeout(resolve, 500));
      setScreen("results");
    } catch (err) {
      setMixError(err.message || "Something went wrong mixing that recipe.");
      setScreen("home");
    }
  }

  // "Mix again" — Phase 3 only. Re-runs the adjustment against the already-
  // ingested original text with the current dietary/preference selections;
  // does not re-fetch, re-paste, or re-validate the input (not a full restart).
  async function runRemix() {
    if (!cleanedRecipeText) {
      await runFullMix();
      return;
    }
    setScreen("loading");
    setStep(1);
    setCopied(false);
    setMixError("");

    try {
      const result = await fetchAdjust(cleanedRecipeText, dietaryRestrictions, preferences);
      setStep(2);
      setMixResult(result);
      setJustSaved(false);
      setAlreadySaved(false);
      setViewingRecipeId(null);
      await new Promise((resolve) => setTimeout(resolve, 400));
      setScreen("results");
    } catch (err) {
      setMixError(err.message || "Something went wrong mixing that recipe.");
      setScreen("results");
    }
  }

  // Entry point for "Mix this recipe up" — nothing reaches runFullMix() (and
  // therefore no screen change, no API call) unless the input validates.
  function startMix() {
    const error = validateRecipeInput(recipeInput, inputMode);
    if (error) {
      setMixError(error);
      setScreen("home");
      return;
    }
    setMixError("");
    runFullMix();
  }

  async function previewRecipe() {
    const trimmed = recipeInput.trim();
    if (!trimmed) {
      setIngest({ status: "error", text: "", error: "Paste a recipe or a link first.", charCount: 0, source: null });
      return;
    }
    setIngest({ status: "loading", text: "", error: "", charCount: 0, source: null });
    try {
      const data = await fetchIngest(trimmed, inputMode);
      setIngest({
        status: "success",
        text: data.text,
        error: "",
        charCount: data.charCount ?? data.text.length,
        source: data.source,
      });
    } catch (err) {
      setIngest({
        status: "error",
        text: "",
        error: err.message || "Couldn't reach the server — is it running?",
        charCount: 0,
        source: null,
      });
    }
  }

  function copyResult() {
    if (!mixResult) return;
    const txt = formatRecipeAsText(mixResult);
    if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(() => {});
    setCopied(true);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1800);
  }

  function saveRecipe() {
    if (justSaved || !mixResult) return;
    const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    const entry = {
      id,
      date: "Just now",
      changes: mixResult.changesSummary.length + " swaps",
      title: mixResult.title,
      tags: allTags,
      note: mixResult.changesSummary.slice(0, 2).join(" "),
      result: mixResult,
      cleanedRecipeText,
    };
    setSavedRecipes((list) => [entry, ...list]);
    setViewingRecipeId(id);
    setJustSaved(true);
  }

  function openSavedRecipe(id) {
    const record = savedRecipes.find((r) => r.id === id);
    if (!record) return;
    setMixResult(record.result);
    setCleanedRecipeText(record.cleanedRecipeText || "");
    setView(null);
    setScreen("results");
    setAlreadySaved(true);
    setViewingRecipeId(id);
  }

  function deleteSavedRecipe(id) {
    setSavedRecipes((list) => list.filter((r) => r.id !== id));
    setConfirmDeleteId(null);
    if (viewingRecipeId === id) {
      setViewingRecipeId(null);
      setAlreadySaved(false);
      setJustSaved(false);
      setScreen("saved");
    }
  }

  const resolvedView = view || "both";
  const showOrig = resolvedView !== "swapped";
  const showSwap = resolvedView !== "original";
  const allTags = dietaryRestrictions.concat(preferences);
  const savedList = savedRecipes.filter(
    (r) =>
      savedFilter === "All" ||
      r.tags.includes(savedFilter) ||
      (savedFilter === "Weeknight" && r.title.indexOf("Weeknight") === 0)
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        fontFamily: "'DM Sans',system-ui,sans-serif",
        color: "oklch(0.26 0.022 52)",
        background: "oklch(0.968 0.016 78)",
        padding: "0 20px 80px",
      }}
    >
      <header style={css("max-width:1120px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 0 10px")}>
        <div style={css("display:flex;align-items:center;gap:10px")}>
          <span style={css("display:inline-flex;width:34px;height:34px")}>
            <img src={whiskIcon} alt="" width="34" height="34" style={{ display: "block", width: 34, height: 34 }} />
          </span>
        </div>
        <div style={css("display:flex;align-items:center;gap:8px;font-size:14px;color:oklch(0.52 0.02 62)")}>
          <Hoverable
            as="button"
            type="button"
            disabled={screen === "loading"}
            onClick={() => setScreen("saved")}
            style={css(
              screen === "loading"
                ? "background:none;border:none;padding:0;font-size:14px;color:oklch(0.52 0.02 62);opacity:0.4;cursor:default"
                : "background:none;border:none;padding:0;font-size:14px;color:oklch(0.52 0.02 62)"
            )}
            hoverStyle={screen === "loading" ? undefined : css("color:oklch(0.55 0.14 42)")}
          >
            Saved recipes
          </Hoverable>
        </div>
      </header>

      {screen === "home" && (
        <main style={css("max-width:820px;margin:0 auto")}>
          <section style={css("text-align:center;padding:44px 0 30px")}>
            <div style={css("display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:99px;background:oklch(0.99 0.008 80);border:1px solid oklch(0.9 0.018 72);color:oklch(0.55 0.14 42);margin-bottom:18px")}>
              <img src={whiskIcon} alt="" width="40" height="40" style={{ display: "block", width: 40, height: 40 }} />
            </div>
            <h1 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(34px,6vw,52px);line-height:1.06;margin:0 0 12px;letter-spacing:-0.01em")}>Recipe Swap</h1>
            <p style={css("margin:0 auto;max-width:470px;font-size:18px;line-height:1.45;color:oklch(0.38 0.02 58);text-wrap:pretty")}>Any recipe, rewritten for the way you eat.</p>
            <p style={css("margin:10px auto 0;max-width:440px;font-size:14px;line-height:1.55;color:oklch(0.56 0.02 62);text-wrap:pretty")}>
              Paste a recipe or a link, tell us what you can't eat and what you wish tasted different — we'll rebalance the ingredients and rewrite the steps.
            </p>
          </section>

          <section style={css("background:oklch(0.995 0.006 82);border:1px solid oklch(0.9 0.018 72);border-radius:18px;padding:8px;box-shadow:0 1px 2px oklch(0.5 0.03 60 / 0.05),0 12px 32px oklch(0.5 0.03 60 / 0.06)")}>
            <div style={css("display:flex;gap:4px;padding:6px 6px 10px")}>
              <button
                type="button"
                style={css(inputMode === "text" ? TAB_ON : TAB_OFF)}
                onClick={() => {
                  setFormState((s) => ({ ...s, inputMode: "text", recipeInput: "" }));
                  setMixError("");
                }}
              >
                Paste text
              </button>
              <button
                type="button"
                style={css(inputMode === "url" ? TAB_ON : TAB_OFF)}
                onClick={() => {
                  setFormState((s) => ({ ...s, inputMode: "url", recipeInput: "" }));
                  setMixError("");
                }}
              >
                Paste a link
              </button>
            </div>

            {inputMode === "text" && (
              <div style={css("padding:0 6px 6px")}>
                <textarea
                  rows={9}
                  placeholder="Paste the full recipe here — ingredients and instructions."
                  value={recipeInput}
                  onChange={(e) => {
                    setFormState((s) => ({ ...s, recipeInput: e.target.value }));
                    setMixError("");
                  }}
                  style={css("width:100%;resize:vertical;border:1px solid oklch(0.9 0.018 72);border-radius:12px;padding:16px;font-size:15px;line-height:1.6;color:oklch(0.26 0.022 52);background:oklch(0.985 0.008 80);outline:none")}
                />
                <div style={css("display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:8px 4px 2px;font-size:13px;color:oklch(0.58 0.02 62)")}>
                  <button
                    type="button"
                    onClick={() => {
                      setFormState((s) => ({ ...s, inputMode: "text", recipeInput: SAMPLE_RECIPE }));
                      setMixError("");
                    }}
                    style={css("background:none;border:none;padding:0;color:oklch(0.55 0.14 42);font-size:13px;text-decoration:underline;text-underline-offset:3px")}
                  >
                    Try it with a sample recipe
                  </button>
                </div>
              </div>
            )}

            {inputMode === "url" && (
              <div style={css("padding:0 6px 6px")}>
                <input
                  type="url"
                  placeholder="https://example.com/best-banana-bread"
                  value={recipeInput}
                  onChange={(e) => {
                    setFormState((s) => ({ ...s, recipeInput: e.target.value }));
                    setMixError("");
                  }}
                  style={css("width:100%;border:1px solid oklch(0.9 0.018 72);border-radius:12px;padding:16px;font-size:15px;color:oklch(0.26 0.022 52);background:oklch(0.985 0.008 80);outline:none")}
                />
                <p style={css("margin:8px 4px 2px;font-size:13px;color:oklch(0.58 0.02 62)")}>We'll pull just the ingredients and steps — no life stories.</p>
              </div>
            )}
          </section>

          {mixError && (
            <p
              style={css(
                "margin:10px 0 0;padding:12px 14px;border:1px solid oklch(0.7 0.16 30 / 0.4);background:oklch(0.97 0.03 30);border-radius:10px;font-size:13.5px;color:oklch(0.4 0.14 30)"
              )}
            >
              {mixError}
            </p>
          )}

          <div style={css("display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:10px")}>
            <button
              type="button"
              onClick={previewRecipe}
              disabled={ingest.status === "loading"}
              style={css(
                "border:1px solid oklch(0.88 0.02 72);background:oklch(0.995 0.006 82);border-radius:99px;padding:9px 16px;font-size:13.5px;color:oklch(0.32 0.02 55)"
              )}
            >
              {ingest.status === "loading" ? "Reading…" : "Preview extracted text"}
            </button>
            {ingest.status === "success" && (
              <span style={css("font-size:13px;color:oklch(0.55 0.02 62)")}>
                {ingest.charCount + " characters extracted" + (ingest.source === "url" ? " from the page" : " from your paste")}
              </span>
            )}
          </div>

          {ingest.status === "error" && (
            <p
              style={css(
                "margin:8px 0 0;padding:12px 14px;border:1px solid oklch(0.7 0.16 30 / 0.4);background:oklch(0.97 0.03 30);border-radius:10px;font-size:13.5px;color:oklch(0.4 0.14 30)"
              )}
            >
              {ingest.error}
            </p>
          )}

          {ingest.status === "success" && (
            <div
              style={css(
                "margin-top:8px;border:1px solid oklch(0.9 0.018 72);border-radius:12px;padding:14px 16px;background:oklch(0.985 0.008 80);max-height:220px;overflow:auto;white-space:pre-wrap;font-size:13.5px;line-height:1.5;color:oklch(0.32 0.02 55)"
              )}
            >
              {ingest.text}
            </div>
          )}

          <section style={css("display:grid;grid-template-columns:repeat(auto-fit,minmax(288px,1fr));gap:16px;margin-top:16px")}>
            <div style={css("background:oklch(0.995 0.006 82);border:1px solid oklch(0.9 0.018 72);border-radius:18px;padding:18px")}>
              <div style={css("display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px")}>
                <h2 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:20px;margin:0")}>Dietary restrictions</h2>
                <span style={css("font-size:12px;font-family:'DM Mono',monospace;color:oklch(0.6 0.02 62)")}>must-follow</span>
              </div>
              <div style={{ height: 14 }} />
              <div style={css("display:flex;flex-wrap:wrap;gap:8px")}>
                {DIETS.map((label) => (
                  <button key={label} type="button" style={chipStyle(dietaryRestrictions.includes(label))} onClick={() => toggleTag(setFormState, "dietaryRestrictions", label)}>
                    {label}
                  </button>
                ))}
              </div>
              <input
                type="text"
                maxLength={60}
                placeholder="Something else — e.g. no nightshades"
                value={customTagValue(dietaryRestrictions, DIETS)}
                onChange={(e) => setCustomTag(setFormState, "dietaryRestrictions", DIETS, e.target.value)}
                style={css("margin-top:14px;width:100%;border:1px dashed oklch(0.86 0.02 72);border-radius:10px;padding:11px 13px;font-size:14px;background:transparent;color:oklch(0.26 0.022 52);outline:none")}
              />
            </div>

            <div style={css("background:oklch(0.995 0.006 82);border:1px solid oklch(0.9 0.018 72);border-radius:18px;padding:18px")}>
              <div style={css("display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:4px")}>
                <h2 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:20px;margin:0")}>Taste &amp; texture</h2>
                <span style={css("font-size:12px;font-family:'DM Mono',monospace;color:oklch(0.6 0.02 62)")}>nice-to-have</span>
              </div>
              <div style={{ height: 14 }} />
              <div style={css("display:flex;flex-wrap:wrap;gap:8px")}>
                {TASTES.map((label) => (
                  <button key={label} type="button" style={chipStyle(preferences.includes(label))} onClick={() => toggleTag(setFormState, "preferences", label)}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 16 }}>
                <div style={css("display:flex;justify-content:space-between;font-size:13px;color:oklch(0.55 0.02 62);margin-bottom:6px")}>
                  <span>How far can we stray from the recipe?</span>
                  <span style={css("font-family:'DM Mono',monospace;color:oklch(0.4 0.03 55)")}>{BOLDNESS_WORDS[boldness]}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={1}
                  value={boldness}
                  onChange={(e) => setBoldness(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "oklch(0.55 0.14 42)" }}
                />
              </div>
              <input
                type="text"
                maxLength={60}
                placeholder="In your words — e.g. more like my grandma's"
                value={customTagValue(preferences, TASTES)}
                onChange={(e) => setCustomTag(setFormState, "preferences", TASTES, e.target.value)}
                style={css("margin-top:14px;width:100%;border:1px dashed oklch(0.86 0.02 72);border-radius:10px;padding:11px 13px;font-size:14px;background:transparent;color:oklch(0.26 0.022 52);outline:none")}
              />
            </div>
          </section>

          <div style={css("display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:26px")}>
            <span style={css("font-size:13.5px;color:oklch(0.55 0.02 62)")}>
              {dietaryRestrictions.length + " restrictions · " + preferences.length + " preferences"}
            </span>
            <Hoverable
              as="button"
              type="button"
              onClick={startMix}
              style={css("border:none;border-radius:99px;background:oklch(0.55 0.14 42);color:oklch(0.985 0.01 80);font-size:17px;font-weight:500;padding:16px 34px;box-shadow:0 6px 18px oklch(0.55 0.14 42 / 0.28)")}
              hoverStyle={css("background:oklch(0.48 0.14 42)")}
            >
              Mix this recipe up
            </Hoverable>
          </div>
        </main>
      )}

      {screen === "saved" && (
        <main style={css("max-width:1120px;margin:0 auto")}>
          <div style={css("display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding:30px 0 20px")}>
            <div>
              <button type="button" onClick={() => setScreen("home")} style={css("background:none;border:none;padding:0;margin-bottom:8px;font-size:13.5px;color:oklch(0.55 0.02 62)")}>
                ← Back to mixing
              </button>
              <h1 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(28px,4.6vw,40px);line-height:1.1;margin:0")}>Saved recipes</h1>
            </div>
            <input
              type="text"
              placeholder="Search your recipes"
              style={css("border:1px solid oklch(0.9 0.018 72);border-radius:99px;padding:11px 18px;font-size:14px;background:oklch(0.995 0.006 82);color:oklch(0.26 0.022 52);outline:none")}
            />
          </div>

          {savedRecipes.length > 0 && (
            <div style={css("display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px")}>
              {SAVED_FILTERS.map((f) => (
                <button key={f} type="button" style={chipStyle(savedFilter === f)} onClick={() => setSavedFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
          )}

          {savedRecipes.length === 0 && (
            <p style={css("margin:0 0 16px;padding:22px;border:1px dashed oklch(0.88 0.02 72);border-radius:14px;font-size:14.5px;color:oklch(0.52 0.02 62);text-align:center")}>
              No saved recipes yet — mix something up and save it to see it here.
            </p>
          )}
          {savedRecipes.length > 0 && savedList.length === 0 && (
            <p style={css("margin:0 0 16px;padding:22px;border:1px dashed oklch(0.88 0.02 72);border-radius:14px;font-size:14.5px;color:oklch(0.52 0.02 62);text-align:center")}>
              Nothing saved under this filter yet.
            </p>
          )}
          <div style={css("display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px")}>
            {savedList.map((r) => (
              <Hoverable
                key={r.id}
                as="article"
                role="button"
                onClick={() => openSavedRecipe(r.id)}
                style={css("background:oklch(0.995 0.006 82);border:1px solid oklch(0.9 0.018 72);border-radius:18px;padding:20px;display:flex;flex-direction:column;gap:12px;min-height:196px;cursor:pointer")}
                hoverStyle={css("border-color:oklch(0.55 0.14 42 / 0.45);box-shadow:0 8px 24px oklch(0.5 0.03 60 / 0.08)")}
              >
                <div style={css("display:flex;align-items:flex-start;justify-content:space-between;gap:10px")}>
                  <span style={css("font-family:'DM Mono',monospace;font-size:11.5px;letter-spacing:0.06em;text-transform:uppercase;color:oklch(0.6 0.02 62)")}>{r.date}</span>
                  <div style={css("display:flex;align-items:center;gap:8px")}>
                    <span style={css("font-family:'DM Mono',monospace;font-size:11.5px;color:oklch(0.55 0.14 42)")}>{r.changes}</span>
                    {confirmDeleteId === r.id ? (
                      <span style={css("display:inline-flex;gap:6px")}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSavedRecipe(r.id);
                          }}
                          style={css("border:none;background:oklch(0.55 0.16 30);color:oklch(0.99 0.006 82);border-radius:99px;padding:4px 10px;font-size:11px")}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(null);
                          }}
                          style={css("border:1px solid oklch(0.85 0.02 70);background:transparent;border-radius:99px;padding:4px 10px;font-size:11px;color:oklch(0.42 0.02 58)")}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label="Delete recipe"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(r.id);
                        }}
                        style={css("border:none;background:transparent;padding:2px 4px;font-size:13px;line-height:1;color:oklch(0.6 0.02 62)")}
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
                <h2 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:21px;line-height:1.2;margin:0;text-wrap:pretty")}>{r.title}</h2>
                <div style={css("display:flex;flex-wrap:wrap;gap:6px")}>
                  {r.tags.map((t) => (
                    <span key={t} style={css("border:1px solid oklch(0.9 0.018 72);background:oklch(0.968 0.016 78);border-radius:99px;padding:4px 10px;font-size:12px;color:oklch(0.44 0.02 58)")}>
                      {t}
                    </span>
                  ))}
                </div>
                <p style={css("margin:0;font-size:13.5px;line-height:1.5;color:oklch(0.52 0.02 60);text-wrap:pretty")}>{r.note}</p>
              </Hoverable>
            ))}
            <Hoverable
              as="button"
              type="button"
              onClick={() => setScreen("home")}
              style={css("border:1px dashed oklch(0.86 0.02 72);background:transparent;border-radius:18px;padding:20px;min-height:196px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:oklch(0.55 0.02 62)")}
              hoverStyle={css("border-color:oklch(0.55 0.14 42);color:oklch(0.55 0.14 42)")}
            >
              <span style={css("font-size:22px;line-height:1")}>+</span>
              <span style={css("font-size:14px")}>Swap a new recipe</span>
            </Hoverable>
          </div>
        </main>
      )}

      {screen === "loading" && (
        <main style={css("max-width:520px;margin:0 auto;padding:90px 0;text-align:center")}>
          <div style={{ position: "relative", width: 120, height: 120, margin: "0 auto 26px" }}>
            <img src={whiskBowl1} alt="" width="120" height="120" style={{ position: "absolute", inset: 0, width: 120, height: 120, animation: "rs-mix-a 0.6s steps(1,end) infinite" }} />
            <img src={whiskBowl2} alt="Mixing" width="120" height="120" style={{ position: "absolute", inset: 0, width: 120, height: 120, animation: "rs-mix-b 0.6s steps(1,end) infinite" }} />
          </div>
          <h2 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:30px;margin:0 0 8px")}>{LOADING_STEP_LABELS[step]}</h2>
          <p style={css("margin:0 0 30px;font-size:15px;color:oklch(0.55 0.02 62)")}>Usually about ten seconds.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left", maxWidth: 340, margin: "0 auto" }}>
            {LOAD_STEPS.map((label, i) => (
              <div key={label} style={css("display:flex;align-items:center;gap:12px")}>
                <span
                  style={css(
                    i < step
                      ? "width:9px;height:9px;border-radius:99px;background:oklch(0.55 0.14 42);flex:none"
                      : i === step
                      ? "width:9px;height:9px;border-radius:99px;background:oklch(0.55 0.14 42);flex:none;animation:rs-pulse 1s ease-in-out infinite"
                      : "width:9px;height:9px;border-radius:99px;background:oklch(0.88 0.02 72);flex:none"
                  )}
                />
                <span style={css(i <= step ? "font-size:14.5px;color:oklch(0.32 0.02 55)" : "font-size:14.5px;color:oklch(0.66 0.02 66)")}>{label}</span>
              </div>
            ))}
          </div>
          <div style={css("margin:34px auto 0;max-width:340px;height:3px;border-radius:99px;background:oklch(0.91 0.015 72);overflow:hidden")}>
            <div style={css("width:30%;height:100%;border-radius:99px;background:oklch(0.55 0.14 42);animation:rs-sweep 1.6s ease-in-out infinite")} />
          </div>
        </main>
      )}

      {screen === "results" && mixResult && (
        <main style={css("max-width:1120px;margin:0 auto")}>
          <div style={css("display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding:26px 0 18px")}>
            <div style={css("min-width:260px")}>
              <button
                type="button"
                onClick={() => {
                  setScreen("home");
                  setViewingRecipeId(null);
                }}
                style={css("background:none;border:none;padding:0;margin-bottom:8px;font-size:13.5px;color:oklch(0.55 0.02 62)")}
              >
                ← Back to mixing
              </button>
              <h1 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:clamp(28px,4.6vw,40px);line-height:1.1;margin:0 0 10px")}>{mixResult.title}</h1>
              <div style={css("display:flex;flex-wrap:wrap;gap:6px")}>
                {allTags.map((label, i) => (
                  <span key={label + i} style={css("border:1px solid oklch(0.88 0.02 72);background:oklch(0.995 0.006 82);border-radius:99px;padding:5px 12px;font-size:12.5px;color:oklch(0.42 0.02 58)")}>
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <div style={css("display:flex;flex-wrap:wrap;gap:8px")}>
              <Hoverable
                as="button"
                type="button"
                onClick={copyResult}
                style={css("border:1px solid oklch(0.88 0.02 72);background:oklch(0.995 0.006 82);border-radius:99px;padding:10px 18px;font-size:14px;color:oklch(0.32 0.02 55)")}
                hoverStyle={css("background:oklch(0.955 0.014 78)")}
              >
                {copied ? "Copied ✓" : "Copy"}
              </Hoverable>
              <Hoverable
                as="button"
                type="button"
                style={css("border:1px solid oklch(0.88 0.02 72);background:oklch(0.995 0.006 82);border-radius:99px;padding:10px 18px;font-size:14px;color:oklch(0.32 0.02 55)")}
                hoverStyle={css("background:oklch(0.955 0.014 78)")}
              >
                Export
              </Hoverable>
              {!alreadySaved && (
                <button
                  type="button"
                  onClick={saveRecipe}
                  style={css(
                    justSaved
                      ? "border:1px solid oklch(0.55 0.09 145);background:oklch(0.95 0.03 145);color:oklch(0.38 0.07 145);border-radius:99px;padding:10px 20px;font-size:14px"
                      : "border:none;background:oklch(0.28 0.03 52);color:oklch(0.985 0.01 80);border-radius:99px;padding:10px 20px;font-size:14px"
                  )}
                >
                  {justSaved ? "Saved to your recipes ✓" : "Save recipe"}
                </button>
              )}
              {viewingRecipeId &&
                (confirmDeleteId === viewingRecipeId ? (
                  <span style={css("display:inline-flex;gap:8px")}>
                    <button
                      type="button"
                      onClick={() => deleteSavedRecipe(viewingRecipeId)}
                      style={css("border:none;background:oklch(0.55 0.16 30);color:oklch(0.99 0.006 82);border-radius:99px;padding:10px 16px;font-size:14px")}
                    >
                      Delete this recipe?
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      style={css("border:1px solid oklch(0.88 0.02 72);background:oklch(0.995 0.006 82);border-radius:99px;padding:10px 16px;font-size:14px;color:oklch(0.32 0.02 55)")}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(viewingRecipeId)}
                    style={css("border:1px solid oklch(0.88 0.02 72);background:oklch(0.995 0.006 82);border-radius:99px;padding:10px 18px;font-size:14px;color:oklch(0.55 0.16 30)")}
                  >
                    Delete
                  </button>
                ))}
            </div>
          </div>

          <div style={css("display:inline-flex;gap:3px;padding:3px;border-radius:99px;background:oklch(0.925 0.016 74);margin-bottom:16px")}>
            <button type="button" style={css(resolvedView === "swapped" ? SEG_ON : SEG_OFF)} onClick={() => setView("swapped")}>Swapped</button>
            <button type="button" style={css(resolvedView === "both" ? SEG_ON : SEG_OFF)} onClick={() => setView("both")}>Compare</button>
            <button type="button" style={css(resolvedView === "original" ? SEG_ON : SEG_OFF)} onClick={() => setView("original")}>Original</button>
          </div>

          <div style={css("display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start")}>
            {showOrig && (
              <section style={css("background:oklch(0.955 0.014 78);border:1px solid oklch(0.9 0.018 72);border-radius:18px;padding:22px")}>
                <div style={css("font-family:'DM Mono',monospace;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:oklch(0.55 0.02 62);margin-bottom:16px")}>Original</div>
                <h3 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:18px;margin:0 0 10px")}>Ingredients</h3>
                <ul style={css("margin:0 0 22px;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px;font-size:15px;line-height:1.45;color:oklch(0.42 0.02 58)")}>
                  {mixResult.originalIngredients.map((ing, i) => (
                    <li key={i}>{formatIngredientLine(ing)}</li>
                  ))}
                </ul>
                <h3 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:18px;margin:0 0 10px")}>Method</h3>
                <ol style={css("margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px;font-size:15px;line-height:1.55;color:oklch(0.42 0.02 58)")}>
                  {mixResult.originalSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>
            )}

            {showSwap && (
              <section style={css("background:oklch(0.995 0.006 82);border:1.5px solid oklch(0.55 0.14 42 / 0.35);border-radius:18px;padding:22px;box-shadow:0 10px 30px oklch(0.5 0.03 60 / 0.07)")}>
                <div style={css("display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px")}>
                  <span style={css("font-family:'DM Mono',monospace;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:oklch(0.55 0.14 42)")}>Swapped</span>
                  <span style={css("font-size:12.5px;color:oklch(0.55 0.02 62)")}>{mixResult.changesSummary.length + " substitutions"}</span>
                </div>
                <h3 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:18px;margin:0 0 10px")}>Ingredients</h3>
                <ul style={css("margin:0 0 22px;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px;font-size:15px;line-height:1.45")}>
                  {mixResult.adjustedIngredients.map((ing, i) => (
                    <li
                      key={i}
                      style={css(
                        ing.changed
                          ? "padding-left:12px;border-left:2px solid oklch(0.55 0.14 42);color:oklch(0.26 0.022 52);font-weight:500"
                          : "padding-left:12px;border-left:2px solid oklch(0.92 0.015 74);color:oklch(0.42 0.02 58)"
                      )}
                    >
                      {formatIngredientLine(ing)}
                    </li>
                  ))}
                </ul>
                <h3 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:18px;margin:0 0 10px")}>Method</h3>
                <ol style={css("margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px;font-size:15px;line-height:1.55")}>
                  {mixResult.adjustedSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>
            )}
          </div>

          <section style={css("margin-top:16px;background:oklch(0.99 0.012 90);border:1px solid oklch(0.89 0.03 85);border-radius:18px;padding:22px")}>
            <h3 style={css("font-family:'Instrument Serif',Georgia,serif;font-weight:400;font-size:21px;margin:0 0 4px")}>What changed, and why</h3>
            <div style={{ height: 18 }} />
            <div style={css("display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px")}>
              {mixResult.changesSummary.map((sentence, i) => {
                const { headline, why } = splitChangeSentence(sentence);
                return (
                  <div key={i} style={css("background:oklch(0.998 0.004 84);border:1px solid oklch(0.91 0.02 78);border-radius:12px;padding:14px 16px")}>
                    <div style={css("font-size:14.5px;font-weight:500;margin-bottom:5px")}>{headline}</div>
                    {why && <div style={css("font-size:13.5px;line-height:1.5;color:oklch(0.48 0.02 60);text-wrap:pretty")}>{why}</div>}
                  </div>
                );
              })}
            </div>
          </section>

          <section style={css("margin-top:16px;background:oklch(0.995 0.006 82);border:1px solid oklch(0.9 0.018 72);border-radius:18px;padding:18px 22px")}>
            <button
              type="button"
              onClick={() => setAdjustOpen((v) => !v)}
              style={css("width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;background:none;border:none;padding:0;text-align:left")}
            >
              <span>
                <span style={css("font-family:'Instrument Serif',Georgia,serif;font-size:21px;display:block")}>Not quite right?</span>
                <span style={css("font-size:13.5px;color:oklch(0.52 0.02 62)")}>Add a note or another preference — we'll keep everything else.</span>
              </span>
              <span style={css("font-size:13px;color:oklch(0.55 0.14 42);white-space:nowrap")}>{adjustOpen ? "Close" : "Adjust further"}</span>
            </button>
            {adjustOpen && (
              <div style={css("margin-top:18px;padding-top:18px;border-top:1px solid oklch(0.92 0.015 74);animation:rs-rise 0.22s ease-out")}>
                <div style={css("display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px")}>
                  {TASTES.map((label) => (
                    <button key={label} type="button" style={chipStyle(preferences.includes(label))} onClick={() => toggleTag(setFormState, "preferences", label)}>
                      {label}
                    </button>
                  ))}
                </div>
                {mixError && (
                  <p
                    style={css(
                      "margin:0 0 14px;padding:12px 14px;border:1px solid oklch(0.7 0.16 30 / 0.4);background:oklch(0.97 0.03 30);border-radius:10px;font-size:13.5px;color:oklch(0.4 0.14 30)"
                    )}
                  >
                    {mixError}
                  </p>
                )}
                <div style={css("display:flex;flex-wrap:wrap;gap:10px")}>
                  <input
                    type="text"
                    maxLength={60}
                    placeholder="e.g. keep it chewy but cut the sugar again"
                    value={customTagValue(preferences, TASTES)}
                    onChange={(e) => setCustomTag(setFormState, "preferences", TASTES, e.target.value)}
                    style={css("flex:1 1 240px;border:1px solid oklch(0.9 0.018 72);border-radius:10px;padding:12px 14px;font-size:14px;background:oklch(0.985 0.008 80);color:oklch(0.26 0.022 52);outline:none")}
                  />
                  <button type="button" onClick={runRemix} style={css("border:none;border-radius:99px;background:oklch(0.55 0.14 42);color:oklch(0.985 0.01 80);font-size:15px;font-weight:500;padding:12px 26px")}>
                    Mix again
                  </button>
                </div>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
