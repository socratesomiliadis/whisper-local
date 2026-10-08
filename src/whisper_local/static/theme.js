// Apply the saved theme before CSS and React load, including under the app's CSP.
(() => {
  if (window.WhisperTheme) return;
  const key = "whisper-theme";
  const event = "whisper-theme-change";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const valid = (value) => ["light", "dark", "system"].includes(value);
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (valid(saved)) preference = saved;
  } catch {
    // Theme switching still works when browser storage is unavailable.
  }
  let snapshot;
  const apply = () => {
    const resolved =
      preference === "system"
        ? system.matches
          ? "dark"
          : "light"
        : preference;
    const next = `${preference}:${resolved}`;
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.dataset.theme = resolved;
    root.style.colorScheme = resolved;
    if (next !== snapshot) {
      snapshot = next;
      window.dispatchEvent(new Event(event));
    }
  };
  window.WhisperTheme = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      window.addEventListener(event, listener);
      return () => window.removeEventListener(event, listener);
    },
    setTheme(value) {
      if (!valid(value)) return;
      preference = value;
      try {
        localStorage.setItem(key, value);
      } catch {
        // The current tab does not need persistent storage.
      }
      apply();
    },
  };
  system.addEventListener("change", () => {
    if (preference === "system") apply();
  });
  window.addEventListener("storage", (change) => {
    if (change.key === key || change.key === null) {
      preference = valid(change.newValue) ? change.newValue : "system";
      apply();
    }
  });
  apply();
})();
