import type { Address, Hex } from "viem";
import { AGENT_URL } from "./agent";
import { arc } from "./arc";

/** What a contributor signs to agree to an invoice; mirrors APPROVE_TYPEHASH in Collective.sol. */
export const approveTypes = {
  ApproveInvoice: [
    { name: "id", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "payer", type: "address" },
    { name: "dueAt", type: "uint64" },
    { name: "reserveBps", type: "uint16" },
    { name: "contributors", type: "address[]" },
    { name: "sharesBps", type: "uint16[]" },
  ],
} as const;

export type Terms = {
  id: Hex;
  amount: bigint;
  payer: Address;
  dueAt: bigint;
  reserveBps: number;
  contributors: readonly Address[];
  sharesBps: readonly number[];
};

export const approveTypedData = (chest: Address, t: Terms) => ({
  domain: { name: "Keyarc", version: "4", chainId: arc.id, verifyingContract: chest },
  types: approveTypes,
  primaryType: "ApproveInvoice" as const,
  message: {
    id: t.id,
    amount: t.amount,
    payer: t.payer,
    dueAt: t.dueAt,
    reserveBps: t.reserveBps,
    contributors: [...t.contributors],
    sharesBps: [...t.sharesBps],
  },
});

/** The agent carries the signed agreement to the chest and pays the gas; the chest checks the signature itself. */
export async function relayApproval(chest: Address, id: Hex, member: Address, signature: Hex): Promise<Hex> {
  const r = await fetch(`${AGENT_URL}/approve?chest=${chest}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, member, signature }),
  });
  const body = (await r.json().catch(() => ({}))) as { tx?: Hex; error?: string };
  if (!r.ok || !body.tx) throw new Error(body.error ?? `agent ${r.status}`);
  return body.tx;
}
