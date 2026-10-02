const STORAGE_KEY = "recipe-swap:saved-recipes";

// localStorage is the only persistence layer this app has — there's no
// backend database for user content (the Express server only handles
// recipe ingestion). Wrapped in try/catch since it can throw in private
// browsing or when storage is disabled.
export function loadSavedRecipes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function persistSavedRecipes(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable — saved recipes just won't survive a refresh.
  }
}
