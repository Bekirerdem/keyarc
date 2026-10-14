import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useConnect, useConnection, useDisconnect } from "wagmi";
import { erc20Abi } from "../lib/abi";
import { publicClient } from "../lib/arc";
import { USDC } from "../lib/contracts";
import { short, usdc } from "../lib/format";
import { LangSwitch, useLang } from "../lib/i18n";
import { Logo } from "../lib/Logo";
import { useArcGuard } from "../lib/tx";

export function useUsdcBalance(address?: `0x${string}`) {
  return useQuery({
    queryKey: ["usdc", address],
    enabled: !!address,
    refetchInterval: 15_000,
    queryFn: () => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
  });
}

export function Wallet() {
  const { address, isConnected } = useConnection();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { onArc, switchToArc } = useArcGuard();
  const bal = useUsdcBalance(address);
  const { t } = useLang();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <div className="card tilt-r pin-gold">
        <div className="label">{t("wallet.label")}</div>
        <p className="note" style={{ margin: "8px 0 14px" }}>{t("wallet.pitch")}</p>
        <button className="btn" disabled={!injected || isPending} onClick={() => injected && connect({ connector: injected })}>
          {isPending ? t("wallet.opening") : t("wallet.connect")}
        </button>
      </div>
    );
  }
  return (
    <div className="card tilt-r pin-gold">
      <div className="between">
        <span className="label">{t("wallet.label")}</span>
        <button className="btn ghost small" onClick={() => disconnect()}>{t("wallet.unpin")}</button>
      </div>
      <div className="mono" style={{ marginTop: 8 }}>{short(address)}</div>
      {onArc ? (
        <div className="amount" style={{ marginTop: 6 }}>{bal.data !== undefined ? usdc(bal.data) : bal.isError ? "—" : "…"}<small>USDC</small></div>
      ) : (
        <button className="btn red small" style={{ marginTop: 10 }} onClick={() => switchToArc()}>{t("wallet.switch")}</button>
      )}
    </div>
  );
}

/** Wraps a write button: not connected → hint, wrong chain → switch button, otherwise the button. */
export function OnArc({ children }: { children: ReactNode }) {
  const { isConnected, onArc, switchToArc } = useArcGuard();
  const { t } = useLang();
  if (!isConnected) return <span className="hint">{t("wallet.needConnect")}</span>;
  if (!onArc) return <button className="btn red small" onClick={() => switchToArc()}>{t("wallet.switch")}</button>;
  return <>{children}</>;
}

export function Brand() {
  const { t } = useLang();
  return (
    <div className="brandrow">
      <Link className="brand" to="/">
        <Logo size={26} />
        <b>Keyarc</b>
        <span>{t("tagline")}</span>
      </Link>
      <LangSwitch />
    </div>
  );
}
