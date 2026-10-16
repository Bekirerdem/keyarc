import { describe, expect, test } from "bun:test";
import { parseUnits } from "viem";
import type { InvoiceReading } from "./llm";
import { assessInvoice, type Vendor } from "./payables";

const figma: Vendor = { name: "Figma", emailDomain: "figma.com", payTo: "0x1111111111111111111111111111111111111111", typicalUsdc: "15", maxUsdc: "60" };

const reading = (over: Partial<InvoiceReading> = {}): InvoiceReading => ({
  vendorName: "Figma", invoiceNumber: "FIG-2026-10", amount: "15.00", currency: "USD", dueDate: "2026-10-20",
  payToAddress: "", asksToChangePaymentDetails: false, pressure: false, embeddedInstructions: false,
  summary: "Figma Professional, October", ...over,
});

const base = { senderDomain: "figma.com", vendor: figma, seenNumbers: [] as string[], isPayee: true, capLeft: parseUnits("100", 6), reserve: parseUnits("500", 6) };

describe("assessInvoice", () => {
  test("a usual invoice from a known, allowlisted supplier is paid to the registered address", () => {
    const a = assessInvoice({ ...base, reading: reading() });
    expect(a.outcome).toBe("paid");
    expect(a.amount).toBe(parseUnits("15", 6));
    expect(a.payTo).toBe(figma.payTo);
  });

  test("ten times the usual amount is held, not paid", () => {
    const a = assessInvoice({ ...base, reading: reading({ amount: "150.00" }) });
    expect(a.outcome).toBe("held");
    expect(a.checks.find((c) => c.name === "amount in usual range")!.ok).toBe(false);
  });

  test("'our wallet changed' is refused and names no payee", () => {
    const a = assessInvoice({ ...base, reading: reading({ amount: "480", asksToChangePaymentDetails: true, payToAddress: "0x9999999999999999999999999999999999999999" }) });
    expect(a.outcome).toBe("rejected");
    expect(a.payTo).toBeNull();
  });

  test("a different wallet in the document is refused even without the words 'changed'", () => {
    const a = assessInvoice({ ...base, reading: reading({ payToAddress: "0x9999999999999999999999999999999999999999" }) });
    expect(a.outcome).toBe("rejected");
  });

  test("instructions aimed at an AI are refused", () => {
    const a = assessInvoice({ ...base, reading: reading({ embeddedInstructions: true }) });
    expect(a.outcome).toBe("rejected");
  });

  test("a duplicate invoice number is refused", () => {
    const a = assessInvoice({ ...base, seenNumbers: ["FIG-2026-10"], reading: reading() });
    expect(a.outcome).toBe("rejected");
  });

  test("an unknown sender is held", () => {
    const a = assessInvoice({ ...base, senderDomain: "figrna.com", vendor: undefined, reading: reading() });
    expect(a.outcome).toBe("held");
    expect(a.payTo).toBeNull();
  });

  test("a known supplier not yet allowlisted on chain is held", () => {
    const a = assessInvoice({ ...base, isPayee: false, reading: reading() });
    expect(a.outcome).toBe("held");
  });

  test("a sound invoice above the agent's period limit goes to a vote", () => {
    const a = assessInvoice({ ...base, capLeft: parseUnits("10", 6), reading: reading() });
    expect(a.outcome).toBe("vote");
    expect(a.payTo).toBe(figma.payTo);
  });

  test("a non-dollar currency is held", () => {
    const a = assessInvoice({ ...base, reading: reading({ currency: "EUR" }) });
    expect(a.outcome).toBe("held");
  });

  test("an unreadable amount never pays", () => {
    const a = assessInvoice({ ...base, reading: reading({ amount: "fifteen" }) });
    expect(a.outcome).not.toBe("paid");
  });
});

describe("shared costs", () => {
  test("a team that keeps no shared-costs share gets the bill held, never paid from anyone's share", () => {
    const a = assessInvoice({ ...base, reserve: 0n, reading: reading() });
    expect(a.outcome).toBe("held");
    expect(a.checks.find((c) => c.name === "covered by shared costs")!.ok).toBe(false);
  });
});
