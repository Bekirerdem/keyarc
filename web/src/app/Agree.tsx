import { useState } from "react";
import type { Address, Hex } from "viem";
import { useConnection, useSignTypedData } from "wagmi";
import { collectiveAbi } from "../lib/abi";
import { approveTypedData, relayApproval } from "../lib/approve";
import { publicClient } from "../lib/arc";
import { useLang } from "../lib/i18n";
import { reason, useToast, useTx } from "../lib/tx";
import { OnArc } from "./Wallet";

/**
 * A contributor agrees to their share. They sign the invoice's terms (free); the agent carries the signature to the
 * chest. If the agent doesn't run this chest, they agree on chain instead, which costs a little gas.
 */
export function AgreeButton({ chest, id, onDone }: { chest: Address; id: Hex; onDone: () => void }) {
  const { t } = useLang();
  const { address: me } = useConnection();
  const { signTypedDataAsync } = useSignTypedData();
  const { send, busy } = useTx();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const label = t("tx.agree");

  async function agree() {
    if (!me) return;
    setWorking(true);
    try {
      // the terms come from the chest, not from the page, so what is signed is what the chest checks
      const [amount, , payer, , dueAt, reserveBps, , contributors, sharesBps] = await publicClient.readContract({
        address: chest, abi: collectiveAbi, functionName: "invoice", args: [id],
      });
      toast({ kind: "pending", text: t("toast.confirm", { label }) });
      const signature = await signTypedDataAsync(approveTypedData(chest, { id, amount, payer, dueAt, reserveBps, contributors, sharesBps }));
      try {
        toast({ kind: "pending", text: t("agree.relaying") });
        const hash = await relayApproval(chest, id, me, signature);
        toast({ kind: "ok", text: t("toast.done", { label }), hash });
        onDone();
      } catch {
        const r = await send(label, { address: chest, abi: collectiveAbi, functionName: "approveInvoice", args: [id] });
        if (r) onDone();
      }
    } catch (e) {
      toast({ kind: "error", text: `${label}: ${reason(e, t)}` });
    } finally {
      setWorking(false);
    }
  }

  return (
    <OnArc>
      <button className="btn red small" disabled={working || busy || !me} onClick={agree}>{working ? t("agree.working") : t("agree.btn")}</button>
    </OnArc>
  );
}
