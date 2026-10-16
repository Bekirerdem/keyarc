import { describe, expect, test } from "bun:test";
import { templateReminder } from "./llm";
import { overdue, withLink } from "./reminders";

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

describe("overdue reminders", () => {
  const A = "0x00000000000000000000000000000000000000000000000000000000000000aa" as const;
  const B = "0x00000000000000000000000000000000000000000000000000000000000000bb" as const;
  const C = "0x00000000000000000000000000000000000000000000000000000000000000cc" as const;
  const now = 1_800_000_000;
  const day = 86_400;
  test("only invoices past their due date, most overdue first; no due date means never", () => {
    const list = [{ id: A, dueAt: now - day }, { id: B, dueAt: now - 5 * day }, { id: C, dueAt: 0 }, { id: C, dueAt: now + day }];
    expect(overdue(list, now, {}).map((i) => i.id)).toEqual([B, A]);
  });
  test("an invoice reminded about in the last three days waits", () => {
    const list = [{ id: A, dueAt: now - 10 * day }];
    expect(overdue(list, now, { [A]: now - day })).toEqual([]);
    expect(overdue(list, now, { [A]: now - 3 * day })).toHaveLength(1);
  });
  test("the template mentions the due date only when the chain has one", () => {
    const r = templateReminder({ lang: "en", team: "Studio", job: "Store upkeep", amountUsdc: "2400", daysOpen: 20, dueDate: "2026-10-14", daysLate: 2 });
    expect(r.message).toContain("due 2026-10-14");
  });
});
