import { describe, expect, test } from "bun:test";
import { templateReminder } from "./llm";
import { withLink } from "./reminders";

const link = "https://keyarc.app/pay/0xd612E26C268375d7ec80FeC3c35623Db9E58aa2c/0x01";

describe("reminders", () => {
  test("the pay link is appended by code on its own line", () => {
    expect(withLink("Hi,\n\nThanks,\nStudio  ", link)).toBe(`Hi,\n\nThanks,\nStudio\n\n${link}`);
  });
  test("the rules-only template carries the amount and the team, in Turkish", () => {
    const r = templateReminder({ lang: "tr", team: "Keyarc Studio", job: "Web sitesi bakımı", amountUsdc: "2000", daysOpen: 9 });
    expect(r.subject).toContain("2000 USDC");
    expect(r.message).toContain("Web sitesi bakımı");
    expect(r.message).toContain("Keyarc Studio");
  });
  test("the template never invents a link or a date", () => {
    const r = templateReminder({ lang: "en", team: "Studio", job: "", amountUsdc: "48", daysOpen: 30 });
    expect(r.message).not.toContain("http");
    expect(r.message).not.toMatch(/\b(19|20)\d\d\b/);
  });
});
