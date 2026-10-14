/**
 * Catch up a chest the agent hasn't scanned for a while (the cron is paused until real teams use it).
 * A Worker pass may read only a few chunks, so the open-invoice index is rebuilt here from the chest's whole history
 * and the scan cursor is moved to the head. Inflows in the skipped range are not judged; pay-link payments are
 * on chain already, and anything else is visible to members on the chest page.
 *
 *   bun scripts/catch-up.ts 0xChest > out.json
 *   bunx wrangler kv key put --binding AGENT_KV --remote open:<chest> --path out.json   (then cursor:<chest> <head>)
 */
import { getAddress, isAddress, type Address } from "viem";
import { applyInvoiceEvents } from "../src/collections";
import { collectiveAbi, publicClient } from "../src/chain";

const CHUNK = 900n;
const arg = process.argv[2] ?? "";
if (!isAddress(arg)) throw new Error("usage: bun scripts/catch-up.ts <chest address>");
const chest: Address = getAddress(arg);

async function creationBlock(): Promise<bigint> {
  let lo = 0n;
  let hi = await publicClient.getBlockNumber();
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const code = await publicClient.getCode({ address: chest, blockNumber: mid });
    if (code && code !== "0x") hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

const head = await publicClient.getBlockNumber();
let index: ReturnType<typeof applyInvoiceEvents> = [];
for (let from = await creationBlock(); from <= head; from += CHUNK + 1n) {
  const to = from + CHUNK > head ? head : from + CHUNK;
  index = applyInvoiceEvents(index, await publicClient.getContractEvents({ address: chest, abi: collectiveAbi, fromBlock: from, toBlock: to }));
}
console.error(`head ${head} · ${index.length} open invoice(s)`);
console.log(JSON.stringify({ head: head.toString(), open: index }));
