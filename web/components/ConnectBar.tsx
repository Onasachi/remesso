"use client";

import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { activeChain } from "@/lib/wagmi";
import { useMiniPayState } from "@/lib/hooks";
import { addressName } from "@/lib/identity";
import { Icon } from "./Icon";

export function ConnectBar({ compact = false }: { compact?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const miniPay = useMiniPayState();
  const inMiniPay = miniPay === true;

  if (!isConnected) {
    // MiniPay injects one account and connects itself on load (see
    // MiniPayAutoConnect). A button there offers a choice that does not exist,
    // and pressing it races the auto-connect already in flight.
    // Also while detection is still running: a button that flashes and then
    // vanishes when MiniPay turns up is still a button MiniPay saw.
    if (miniPay !== false) {
      return (
        <span className="flex items-center gap-2 text-[13px] text-ink-3">
          <Dot className="bg-ink-3 animate-pulse2" />
          Connecting
        </span>
      );
    }
    const injected = connectors.find((c) => c.id === "injected");
    return (
      <button
        className="btn-ink btn-sm"
        disabled={!injected || isPending}
        onClick={() => injected && connect({ connector: injected })}
      >
        {isPending ? "Connecting…" : injected ? "Connect wallet" : "No wallet found"}
      </button>
    );
  }

  if (chainId !== activeChain.id) {
    // MiniPay is Celo-only and cannot switch, so offering the button there is a
    // dead end. It should never happen; say something true if it does.
    if (inMiniPay) {
      return (
        <span className="rounded-full bg-amber-soft px-3 py-1.5 text-[13px] text-ink">
          Wrong network
        </span>
      );
    }
    return (
      <button className="btn-primary btn-sm" onClick={() => switchChain({ chainId: activeChain.id })}>
        Switch to {activeChain.name}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* MiniPay prohibits showing the wallet address anywhere — a truncated
          0x1234…abcd is explicitly not an escape hatch. A stable generated name
          identifies the session without putting hex on screen. */}
      <span className="flex max-w-[11rem] items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-2.5 pr-3 text-[13px] font-medium text-ink">
        <Dot className="shrink-0 bg-naira" />
        <span className="truncate">{addressName(address)}</span>
      </span>
      {/* MiniPay owns the session; disconnecting inside it just strands the app. */}
      {miniPay === false && !compact && (
        <button className="icon-btn" onClick={() => disconnect()} aria-label="Sign out" title="Sign out">
          <Icon name="logout" />
        </button>
      )}
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${className}`} aria-hidden />;
}
