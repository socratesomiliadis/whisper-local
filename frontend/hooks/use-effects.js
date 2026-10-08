import { useEffect, useState } from "react";

// Keep short operations quiet and cancel the timer when the work finishes.
export function useDelayedActive(active, delay = 2000) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!active) return;
    const timer = window.setTimeout(() => setReady(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);
  return active && ready;
}

export function useEffectPreferences() {
  const [preferences, setPreferences] = useState(() => ({
    visible: !document.hidden,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches,
  }));
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () =>
      setPreferences({
        visible: !document.hidden,
        reducedMotion: preference.matches,
      });
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return preferences;
}
