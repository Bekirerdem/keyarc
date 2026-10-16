import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { collectiveAbi } from "../lib/abi";
import { publicClient } from "../lib/arc";
import { versionOf } from "../lib/contracts";
import { collectiveLogs, type CollectiveEvent } from "../lib/logs";

export type Rules = {
  reserveBps: number;
  reserveTarget: bigint;
  autoAttributeCap: bigint;
  expenseCapPerPeriod: bigint;
  quorumBps: number;
  timelock: number;
  periodLength: number;
};

export type Proposal = {
  id: number;
  kind: number;
  payload: Hex;
  ref: Hex;
  proposer: Address;
  executableAt: number;
  expiresAt: number;
  epoch: bigint;
  votes: number;
  votesNeeded: number;
  executed: boolean;
  cancelled: boolean;
  iVoted: boolean;
};

/** One share that went out: to whom, where it landed and how much. */
export type Payout = { member: Address; to: Address; amount: bigint; tx: Hex };

export type Invoice = {
  id: Hex;
  creator: Address;
  amount: bigint;
  payer: Address;
  status: number;
  dueAt: number;
  note: string;
  contributors: readonly Address[];
  sharesBps: readonly number[];
  /** Lower-cased addresses of the contributors who agreed to their share (the creator agrees by writing it). */
  agreed: Set<string>;
  createdTx: Hex;
  createdBlock: bigint;
  paidTx?: Hex;
  toReserve?: bigint;
  payouts: Payout[];
};

export type Chest = {
  address: Address;
  name: string;
  members: readonly Address[];
  agent: Address;
  rules: Rules;
  /** Set aside for shared costs. Shares never wait in the chest: they go out when the client pays. */
  reserve: bigint;
  unattributed: bigint;
  attributeLeft: bigint;
  expenseLeft: bigint;
  governanceEpoch: bigint;
  owedToMe: bigint;
  proposals: Proposal[];
};

/** A chest made by an earlier Keyarc version: its history stays on Arc, the app no longer runs it. */
export class OlderChest extends Error {
  readonly version: string;
  constructor(version: string) {
    super(`chest runs Keyarc ${version}`);
    this.version = version;
  }
}

const c = (address: Address) => ({ address, abi: collectiveAbi }) as const;

export async function readChest(address: Address, me?: Address): Promise<Chest> {
  const version = versionOf(await publicClient.getCode({ address }));
  if (version !== "current") throw version ? new OlderChest(version) : new Error("not a Keyarc chest");

  const [name, members, agent, rules, reserve, unattributed, room, epoch, proposalCount, owedToMe] =
    await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { ...c(address), functionName: "name" },
        { ...c(address), functionName: "members" },
        { ...c(address), functionName: "agent" },
        { ...c(address), functionName: "rules" },
        { ...c(address), functionName: "reserve" },
        { ...c(address), functionName: "unattributed" },
        { ...c(address), functionName: "agentRoom" },
        { ...c(address), functionName: "governanceEpoch" },
        { ...c(address), functionName: "proposalCount" },
        { ...c(address), functionName: "owed", args: [me ?? "0x0000000000000000000000000000000000000000"] },
      ],
    });

  const n = Number(proposalCount);
  const ids = Array.from({ length: Math.min(n, 30) }, (_, i) => n - 1 - i); // newest 30
  const [props, voted] = ids.length
    ? await Promise.all([
        publicClient.multicall({
          allowFailure: false,
          contracts: ids.map((i) => ({ ...c(address), functionName: "proposal", args: [BigInt(i)] }) as const),
        }),
        me
          ? publicClient.multicall({
              allowFailure: false,
              contracts: ids.map((i) => ({ ...c(address), functionName: "hasVoted", args: [BigInt(i), me] }) as const),
            })
          : Promise.resolve(ids.map(() => false)),
      ])
    : [[], []];

  return {
    address,
    name,
    members,
    agent,
    rules: {
      reserveBps: rules.reserveBps,
      reserveTarget: rules.reserveTarget,
      autoAttributeCap: rules.autoAttributeCap,
      expenseCapPerPeriod: rules.expenseCapPerPeriod,
      quorumBps: rules.quorumBps,
      timelock: rules.timelock,
      periodLength: rules.periodLength,
    },
    reserve,
    unattributed,
    attributeLeft: room[0],
    expenseLeft: room[1],
    governanceEpoch: epoch,
    owedToMe,
    proposals: props.map((p, k) => ({
      id: ids[k],
      kind: p.kind,
      payload: p.payload,
      ref: p.ref,
      proposer: p.proposer,
      executableAt: Number(p.executableAt),
      expiresAt: Number(p.expiresAt),
      epoch: p.epoch,
      votes: p.votes,
      votesNeeded: p.votesNeeded,
      executed: p.executed,
      cancelled: p.cancelled,
      iVoted: voted[k] as boolean,
    })),
  };
}

export function useChest(address?: Address, me?: Address) {
  return useQuery({
    queryKey: ["chest", address, me],
    enabled: !!address,
    refetchInterval: 20_000,
    retry: (n, e) => !(e instanceof OlderChest) && n < 3,
    queryFn: () => readChest(address!, me),
  });
}

export function useChestEvents(address?: Address) {
  return useQuery({
    queryKey: ["chest-events", address],
    enabled: !!address,
    refetchInterval: 30_000,
    queryFn: () => collectiveLogs(address!),
  });
}

/** Invoices rebuilt from the chest's events: who wrote them, who agreed, how each was paid out. Newest first. */
export function invoicesFrom(events: CollectiveEvent[]): Invoice[] {
  const map = new Map<string, Invoice>();
  const get = (id: Hex) => map.get(id.toLowerCase());
  for (const e of events) {
    const a = e.args as Record<string, unknown>;
    if (e.eventName === "InvoiceCreated") {
      const contributors = a.contributors as readonly Address[];
      const creator = a.creator as Address;
      map.set((a.id as Hex).toLowerCase(), {
        id: a.id as Hex,
        creator,
        amount: a.amount as bigint,
        payer: a.payer as Address,
        status: 1,
        dueAt: Number((a.dueAt as bigint | undefined) ?? 0n),
        note: (a.note as string | undefined) ?? "",
        contributors,
        sharesBps: a.sharesBps as readonly number[],
        agreed: new Set(contributors.filter((m) => m.toLowerCase() === creator.toLowerCase()).map((m) => m.toLowerCase())),
        createdTx: e.transactionHash,
        createdBlock: e.blockNumber,
        payouts: [],
      });
    } else if (e.eventName === "InvoiceApproved") {
      get(a.id as Hex)?.agreed.add((a.member as string).toLowerCase());
    } else if (e.eventName === "InvoicePaid") {
      const inv = get(a.id as Hex);
      if (inv) Object.assign(inv, { status: 2, paidTx: e.transactionHash, toReserve: a.toReserve as bigint });
    } else if (e.eventName === "InvoiceCancelled") {
      const inv = get(a.id as Hex);
      if (inv) inv.status = 3;
    } else if (e.eventName === "Paid" || e.eventName === "PayoutDeferred") {
      const inv = get(a.source as Hex);
      if (inv) inv.payouts.push({ member: a.member as Address, to: ((a.to as Address | undefined) ?? a.member) as Address, amount: a.amount as bigint, tx: e.transactionHash });
    }
  }
  return [...map.values()].reverse();
}

/** Contributors on an invoice who haven't agreed to their share yet. */
export const waitingOn = (inv: Invoice) => inv.contributors.filter((m) => !inv.agreed.has(m.toLowerCase()));

/** USDC paid to each member, from the chest's Paid events. */
export function paidByMember(events: CollectiveEvent[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const e of events) {
    if (e.eventName !== "Paid") continue;
    const a = e.args as { member: Address; amount: bigint };
    const k = a.member.toLowerCase();
    out.set(k, (out.get(k) ?? 0n) + a.amount);
  }
  return out;
}
