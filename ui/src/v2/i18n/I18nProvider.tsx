import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  normalizeDashboardLocale,
  translate,
  type DashboardLocale,
  type MessageKey,
} from "./translations";

const STORAGE_KEY = "jarvis-language";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

interface I18nValue {
  locale: DashboardLocale;
  setLocale: (locale: DashboardLocale) => void;
  t: Translate;
}

const fallbackValue: I18nValue = {
  locale: "en",
  setLocale: () => undefined,
  t: (key, values) => translate("en", key, values),
};

const I18nContext = createContext<I18nValue>(fallbackValue);

function initialLocale(): DashboardLocale {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeDashboardLocale(stored);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
  return normalizeDashboardLocale(document.documentElement.lang || navigator.language);
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<DashboardLocale>(initialLocale);

  const setLocale = useCallback((next: DashboardLocale) => {
    const normalized = normalizeDashboardLocale(next);
    setLocaleState(normalized);
    try { window.localStorage.setItem(STORAGE_KEY, normalized); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale,
    t: (key, values) => translate(locale, key, values),
  }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
