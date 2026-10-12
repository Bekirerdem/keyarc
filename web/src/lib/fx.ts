import { parseAbi, type Address } from "viem";
import { publicClient } from "./arc";

/**
 * USDC → EURC on Arc mainnet through the Uniswap v3 pool (fee 0.05%).
 * Router and pool verified on chain 2026-10-12: both report factory 0xf0db…4918; pool token0 USDC, token1 EURC.
 */
export const EURC: Address = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
export const SWAP_ROUTER: Address = "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77";
export const USDC_EURC_POOL: Address = "0x6fd5f2fb831940dcd61a98c5b3acb7d8c6f3bfc1";
export const POOL_FEE = 500;
/** Max slippage accepted on a member's own swap. */
export const SLIPPAGE_BPS = 100n;

export const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const poolAbi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"]);

const Q192 = 2n ** 192n;

/** EURC out for `usdcIn` at the pool's current price (both 6 decimals), before fee and slippage. */
export async function quoteEurc(usdcIn: bigint): Promise<{ out: bigint; min: bigint }> {
  const [sqrtPriceX96] = await publicClient.readContract({ address: USDC_EURC_POOL, abi: poolAbi, functionName: "slot0" });
  const spot = (usdcIn * sqrtPriceX96 * sqrtPriceX96) / Q192; // token1 per token0
  const out = spot - (spot * BigInt(POOL_FEE)) / 1_000_000n;
  return { out, min: out - (out * SLIPPAGE_BPS) / 10_000n };
}
