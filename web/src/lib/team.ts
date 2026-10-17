import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Address } from "viem";
import { collectiveAbi, factoryAbi } from "./abi";
import { publicClient } from "./arc";
import { FACTORY } from "./contracts";
import { short } from "./format";

export type MyChest = { address: Address; name: string };

/** Chests from the current factory where `me` is still a member, newest first. */
export function useMyChests(me?: Address) {
  return useQuery({
    queryKey: ["my-chests", me],
    enabled: !!me,
    queryFn: async (): Promise<MyChest[]> => {
      const list = await publicClient.readContract({ address: FACTORY, abi: factoryAbi, functionName: "collectivesOf", args: [me!] });
      if (!list.length) return [];
      const reads = await publicClient.multicall({
        allowFailure: false,
        contracts: list.flatMap((a) => [
          { address: a, abi: collectiveAbi, functionName: "name" } as const,
          { address: a, abi: collectiveAbi, functionName: "isMember", args: [me!] } as const,
        ]),
      });
      // collectivesOf can be padded by strangers listing you as a member and then removing you; keep only live memberships.
      return list
        .map((a, i) => ({ address: a, name: reads[i * 2] as string, member: reads[i * 2 + 1] as boolean }))
        .filter((x) => x.member)
        .map(({ address, name }) => ({ address, name }))
        .reverse();
    },
  });
}

// ── nicknames: names are a convenience for this browser only, never on chain ──
type Names = Record<string, string>;
const namesKey = (chest: Address) => `keyarc:names:${chest.toLowerCase()}`;

export function loadNames(chest: Address): Names {
  try {
    return JSON.parse(localStorage.getItem(namesKey(chest)) ?? "{}") as Names;
  } catch {
    return {};
  }
}

export function saveNames(chest: Address, names: Names) {
  try {
    const merged = { ...loadNames(chest), ...Object.fromEntries(Object.entries(names).map(([k, v]) => [k.toLowerCase(), v.trim()]).filter(([, v]) => v)) };
    localStorage.setItem(namesKey(chest), JSON.stringify(merged));
  } catch {
    /* blocked storage: addresses still show */
  }
}

/** `who(address)` → saved nickname or a short address. */
/** Names travel with the link a member shares, in the #fragment, which browsers never send to a server. */
export function namesFragment(chest: Address): string {
  const parts = Object.entries(loadNames(chest)).filter(([, v]) => v).map(([a, v]) => `${a}:${encodeURIComponent(v)}`);
  return parts.length ? `#n=${parts.join(",")}` : "";
}

/** A teammate opening a shared link picks up the names they don't have yet; a name they set themselves wins. */
export function importNamesFromLink() {
  const chest = /^\/(?:pay|c)\/(0x[0-9a-fA-F]{40})/.exec(window.location.pathname)?.[1] as Address | undefined;
  const frag = /^#(?:.*&)?n=([^&]*)/.exec(window.location.hash)?.[1];
  if (!chest || !frag) return;
  const mine = loadNames(chest);
  const incoming: Names = {};
  for (const part of frag.split(",")) {
    const i = part.indexOf(":");
    const addr = part.slice(0, i).toLowerCase();
    let name: string;
    try {
      name = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    name = name.replace(/\p{Cc}/gu, "").trim().slice(0, 40);
    if (/^0x[0-9a-f]{40}$/.test(addr) && name && !mine[addr]) incoming[addr] = name;
  }
  if (Object.keys(incoming).length) saveNames(chest, incoming);
}

export function useNames(chest?: Address) {
  const [names] = useState<Names>(() => (chest ? loadNames(chest) : {}));
  return useCallback((a: string) => names[a.toLowerCase()] || short(a), [names]);
}
