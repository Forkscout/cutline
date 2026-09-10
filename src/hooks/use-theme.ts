import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "cutline.theme";

/**
 * The app is light by default, whatever the operating system says.
 *
 * That is a design decision rather than an oversight: the capture and library
 * surfaces are meant to read like paper, and the editor stamps itself dark
 * regardless because colour work needs a neutral surround. Respecting
 * `prefers-color-scheme` here would give the two halves the same appearance
 * and lose the distinction. The toggle keeps it the viewer's call.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(KEY);
      return saved === "dark" || saved === "light" ? saved : "light";
    } catch {
      return "light";
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // A private window without storage still gets a working theme.
    }
  }, [theme]);

  return { theme, setTheme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") };
}
