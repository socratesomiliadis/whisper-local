import { useSyncExternalStore } from "react";

export function useTheme() {
  const store = window.WhisperTheme;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [theme, resolvedTheme] = snapshot.split(":");
  return { theme, resolvedTheme, setTheme: store.setTheme };
}
