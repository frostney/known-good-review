import { describe, expect, test } from "bun:test";
import { discoverabilityApplies } from "../src/review/discoverability";

describe("deterministic discoverability activation", () => {
  test("activates for configured public roots and explicit content signals", () => {
    expect(discoverabilityApplies(["public-site/about.tsx"], ["public-site"])).toBe(
      true,
    );
    expect(discoverabilityApplies(["website/src/app.tsx"], [])).toBe(true);
    expect(discoverabilityApplies(["src/app/sitemap.ts"], [])).toBe(true);
    expect(discoverabilityApplies(["src/seo/metadata.ts"], [])).toBe(true);
  });

  test("does not infer publicness from generic framework or schema paths", () => {
    expect(discoverabilityApplies(["src/app/settings/page.tsx"], [])).toBe(false);
    expect(discoverabilityApplies(["convex/schema.ts"], [])).toBe(false);
    expect(discoverabilityApplies(["src/app/api/route.ts"], [])).toBe(false);
  });
});
