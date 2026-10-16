import { describe, expect, test } from "bun:test";
import { firstBlockWith, isCurrentClone, isKeyarcClone, spans, WINDOW } from "./logindex";
import deployment from "../../deployments/arc-mainnet.json";

describe("log index", () => {
  test("the creation block is found exactly, in a handful of batched rounds", async () => {
    for (const born of [0n, 1n, 24n, 25n, 26n, 25_505_569n, 26_117_543n]) {
      let rounds = 0;
      const has = async (bs: bigint[]) => {
        rounds++;
        return bs.map((b) => b >= born);
      };
      expect(await firstBlockWith(has, 26_117_543n)).toBe(born);
      expect(rounds).toBeLessThanOrEqual(7);
    }
  });
  test("ranges are inclusive, contiguous and capped", () => {
    expect(spans(10n, 2_509n, 1000n)).toEqual([[10n, 1_009n], [1_010n, 2_009n], [2_010n, 2_509n]]);
    expect(spans(5n, 5n, 1000n)).toEqual([[5n, 5n]]);
    expect(spans(6n, 5n, 1000n)).toEqual([]);
    expect(WINDOW).toBe(25_000n);
  });
  test("only clones of a Keyarc implementation are indexed", () => {
    const clone = (impl: string) => `0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`;
    expect(isKeyarcClone(clone("95aaa5594942912d4d5011d64f876069f2d37cc9"))).toBe(true);
    expect(isKeyarcClone(clone("95AAA5594942912D4D5011D64F876069F2D37CC9"))).toBe(true);
    expect(isKeyarcClone(clone("1111111111111111111111111111111111111111"))).toBe(false);
    expect(isKeyarcClone("0x")).toBe(false);
  });
  test("the agent runs only chests on the current version", () => {
    const clone = (impl: string) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    expect(isCurrentClone(clone(deployment.implementation))).toBe(true);
    expect(isCurrentClone(clone(deployment.v2.implementation))).toBe(false);
  });
});
