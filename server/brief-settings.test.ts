import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseConfigPatch, parseStoredConfig } from "./config.ts";
import { briefAwayMs, briefRecapEnabled, briefSettings, DEFAULT_BRIEF_AWAY_HOURS } from "./brief-settings.ts";

describe("briefSettings", () => {
  const features = z.object({ browser: z.boolean().optional() }).extend(briefSettings);

  it("is the brief's two settings, each optional, beside whatever else the group holds", () => {
    expect(Object.keys(briefSettings).sort()).toEqual(["briefAwayHours", "briefRecap"]);
    expect(features.parse({})).toEqual({});
    expect(features.parse({ browser: false, briefRecap: false, briefAwayHours: 6 })).toEqual({ browser: false, briefRecap: false, briefAwayHours: 6 });
  });

  it("takes away hours as a positive number of at most a week", () => {
    for (const value of [0.5, 3, 168]) expect(features.parse({ briefAwayHours: value })).toEqual({ briefAwayHours: value });
    for (const value of [0, -1, 169, "3", null]) expect(() => features.parse({ briefAwayHours: value })).toThrow();
  });
});

describe("briefRecapEnabled", () => {
  const NO_ENV: NodeJS.ProcessEnv = {};
  it("is on unless the setting says false", () => {
    expect(briefRecapEnabled(undefined, NO_ENV)).toBe(true);
    expect(briefRecapEnabled({}, NO_ENV)).toBe(true);
    expect(briefRecapEnabled({ briefRecap: false }, NO_ENV)).toBe(false);
  });
  it("lets OMB_BRIEF_RECAP win over the file, both ways", () => {
    expect(briefRecapEnabled({ briefRecap: true }, { OMB_BRIEF_RECAP: "0" })).toBe(false);
    expect(briefRecapEnabled({ briefRecap: false }, { OMB_BRIEF_RECAP: "1" })).toBe(true);
    for (const value of ["", "yes", "2"]) expect(briefRecapEnabled({ briefRecap: false }, { OMB_BRIEF_RECAP: value })).toBe(false);
  });
});

describe("briefAwayMs", () => {
  it("defaults to three hours and honours the setting", () => {
    expect(DEFAULT_BRIEF_AWAY_HOURS).toBe(3);
    expect(briefAwayMs(undefined)).toBe(3 * 60 * 60_000);
    expect(briefAwayMs({ briefAwayHours: 0.5 })).toBe(30 * 60_000);
    expect(briefAwayMs({ briefAwayHours: Number.NaN })).toBe(3 * 60 * 60_000);
  });
});

describe("the features group in server/config.ts", () => {
  const features = { briefRecap: false, briefAwayHours: 5 };

  it("keeps both settings through a PATCH and a stored config", () => {
    expect(parseConfigPatch({ features })).toEqual({ features });
    expect(parseStoredConfig({ features }).features).toEqual(features);
  });

  it("refuses an away time that is not positive", () => {
    expect(() => parseConfigPatch({ features: { briefAwayHours: 0 } })).toThrow("features.briefAwayHours");
  });
});
