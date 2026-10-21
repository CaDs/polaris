// Apply the last known appearance before first paint (no flash): a copy of the user's saved preferences.
// No saved mode = follow the OS; no palette = the default.
try {
  const t = localStorage.getItem("theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  const p = localStorage.getItem("palette");
  if (p) document.documentElement.dataset.palette = p;
} catch {}
