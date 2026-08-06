import { describe, expect, test } from "bun:test";
import { normalizeDashboardLocale, translate } from "./translations";

describe("dashboard translations", () => {
  test("normalizes Spanish BCP-47 and underscore locales", () => {
    expect(normalizeDashboardLocale("es-MX")).toBe("es");
    expect(normalizeDashboardLocale("ES_es")).toBe("es");
  });

  test("falls back to English for unsupported or invalid locales", () => {
    expect(normalizeDashboardLocale("fr-FR")).toBe("en");
    expect(normalizeDashboardLocale(undefined)).toBe("en");
  });

  test("interpolates values in either catalog", () => {
    expect(translate("en", "notifications.unread", { count: 3 })).toBe("3 unread");
    expect(translate("es", "notifications.unread", { count: 3 })).toBe("3 sin leer");
    expect(translate("es", "settings.general.specialists", { count: 2 })).toBe(
      "Especialistas disponibles (2)",
    );
  });
});
