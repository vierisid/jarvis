import { describe, expect, test } from "bun:test";
import { ONBOARDING_COPY } from "./onboardingCopy";

describe("onboarding copy", () => {
  test("keeps state-bearing option ids aligned across locales", () => {
    expect(ONBOARDING_COPY.es.permissions.rows.map((item) => item.id))
      .toEqual(ONBOARDING_COPY.en.permissions.rows.map((item) => item.id));
    expect(ONBOARDING_COPY.es.hearing.choices.map((item) => item.id))
      .toEqual(ONBOARDING_COPY.en.hearing.choices.map((item) => item.id));
    expect(ONBOARDING_COPY.es.speaking.choices.map((item) => item.id))
      .toEqual(ONBOARDING_COPY.en.speaking.choices.map((item) => item.id));
    expect(ONBOARDING_COPY.es.connect.rows.map((item) => item.id))
      .toEqual(ONBOARDING_COPY.en.connect.rows.map((item) => item.id));
  });

  test("provides every step label and tour card in both languages", () => {
    expect(Object.keys(ONBOARDING_COPY.es.steps)).toEqual(Object.keys(ONBOARDING_COPY.en.steps));
    expect(ONBOARDING_COPY.es.tour.cards).toHaveLength(ONBOARDING_COPY.en.tour.cards.length);
    expect(ONBOARDING_COPY.es.steps.interview).toBe("La entrevista");
  });

  test("formats localized progress labels", () => {
    expect(ONBOARDING_COPY.en.stepProgress(2, 9, "Permissions")).toBe("Step 2 of 9 · Permissions");
    expect(ONBOARDING_COPY.es.stepProgress(2, 9, "Permisos")).toBe("Paso 2 de 9 · Permisos");
  });
});
