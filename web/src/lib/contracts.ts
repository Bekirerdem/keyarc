import deployment from "./deployment.json";
import type { Address } from "viem";

export const FACTORY = deployment.factory as Address;
export const USDC = deployment.usdc as Address;
export const MEMO = deployment.memo as Address;
export const PROOF_CHEST = deployment.proof.collective as Address;
export const DEMO_CHEST = deployment.demo.collective as Address;
/** The hosted treasury agent; new chests can opt into it. */
export const AGENT = deployment.demo.agent as Address;

export const InvoiceStatus = ["None", "Open", "Paid", "Cancelled"] as const;
export const ProposalKind = [
  "SetRules", "AddMember", "RemoveMember", "SetAgent", "SetPayee", "ReleaseReserve", "Attribute", "Expense", "SettleInvoice",
] as const;
export type ProposalKindName = (typeof ProposalKind)[number];
export const kindIndex = (k: ProposalKindName) => ProposalKind.indexOf(k);

const bare = (a: string) => a.toLowerCase().replace(/^0x/, "");
const IMPLEMENTATIONS: [string, string][] = [
  ["current", bare(deployment.implementation)],
  ["v3", bare(deployment.v3.implementation)],
  ["v2", bare(deployment.v2.implementation)],
  ["v1", bare(deployment.v1.implementation)],
];

/** Which Keyarc version a chest's code is a clone of ("current" for the one this app runs), or null if none. */
export function versionOf(code: string | undefined): string | null {
  const c = (code ?? "").toLowerCase();
  if (!c.startsWith("0x363d3d373d3d3d363d73")) return null;
  const impl = c.slice(22, 62);
  return IMPLEMENTATIONS.find(([, i]) => i === impl)?.[0] ?? null;
}
