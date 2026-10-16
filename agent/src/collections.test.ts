import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import { applyInvoiceEvents, pays } from "./collections";

const u = (s: string) => parseUnits(s, 6);

describe("pays", () => {
  test("exact amount pays", () => expect(pays(u("250"), u("250"))).toBe(true));
  test("a fast-transfer overpay within 0.5% pays", () => expect(pays(u("250.9"), u("250"))).toBe(true));
  test("more than 0.5% over does not pay", () => expect(pays(u("252"), u("250"))).toBe(false));
  test("short by one micro-dollar does not pay", () => expect(pays(u("249.999999"), u("250"))).toBe(false));
});

describe("applyInvoiceEvents", () => {
  const A = "0x00000000000000000000000000000000000000000000000000000000000000aa" as const;
  const B = "0x00000000000000000000000000000000000000000000000000000000000000bb" as const;
  const who = "0x39AEfbC8388da12907A21d9De888B288a9fa5794" as const;
  const created = (id: `0x${string}`, block: bigint) => ({ eventName: "InvoiceCreated", blockNumber: block, args: { id, amount: u("2000"), payer: who, creator: who } });
  const paid = (id: `0x${string}`, block: bigint) => ({ eventName: "InvoicePaid", blockNumber: block, args: { id } });

  test("keeps created invoices and drops paid ones", () => {
    const index = applyInvoiceEvents([], [created(A, 1n), created(B, 2n), paid(A, 3n)]);
    expect(index.map((i) => i.id)).toEqual([B]);
    expect(index[0].amount).toBe(u("2000").toString());
  });
  test("re-scanning the same blocks gives the same index", () => {
    const events = [created(A, 1n), created(B, 2n), paid(A, 3n)];
    const once = applyInvoiceEvents([], events);
    expect(applyInvoiceEvents(once, events)).toEqual(once);
  });
});

describe("open invoice index (v4 events)", () => {
  const A = "0x00000000000000000000000000000000000000000000000000000000000000aa" as const;
  const who = "0x39AEfbC8388da12907A21d9De888B288a9fa5794" as const;
  test("keeps the due date and what the invoice was for", () => {
    const index = applyInvoiceEvents([], [{ eventName: "InvoiceCreated", blockNumber: 7n, args: { id: A, amount: u("2400"), payer: who, creator: who, dueAt: 1_800_000_000n, note: "Store upkeep + SEO · October" } }]);
    expect(index[0].dueAt).toBe("1800000000");
    expect(index[0].note).toBe("Store upkeep + SEO · October");
  });
});
