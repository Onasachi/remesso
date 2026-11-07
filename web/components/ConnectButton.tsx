"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConnect } from "wagmi";
import { Sheet } from "./ui";
import { Icon } from "./Icon";

/// The page's address, opened inside a wallet's own browser. MiniPay has no
/// public open-this-page link (`link.minipay.xyz/browse` is provisioned on
/// request), so it isn't offered. The same two links `prepare_payment` gives.
export function walletLinks(url: string) {
  return {
    metamask: `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}`,
    trust: `https://link.trustwallet.com/open_url?coin_id=52752&url=${encodeURIComponent(url)}`,
  };
}

/// Read when the button is pressed, not at render: a wallet can inject late,
/// and by the time someone taps, it has.
function hasInjectedWallet(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as { ethereum?: unknown }).ethereum)
  );
}

/// "Connect wallet", for a browser that may have no wallet in it.
///
/// wagmi's `injected` connector exists whether or not a wallet does, so the
/// old button always read "Connect wallet", and in a browser with no wallet
/// a tap failed silently. That is where every link from the Claude app lands:
/// the in-app browser, or Safari and Chrome, none of which inject. Without a
/// wallet the tap now explains that and offers to reopen the page in one.
export function ConnectButton({
  className,
  children,
}: {
  className: string;
  children: (pending: boolean) => ReactNode;
}) {
  const { connect, connectors, isPending } = useConnect();
  const [help, setHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const injected = connectors.find((c) => c.id === "injected");

  const onClick = () => {
    if (injected && hasInjectedWallet()) connect({ connector: injected });
    else setHelp(true);
  };

  const url = typeof window === "undefined" ? "" : window.location.href;
  const links = walletLinks(url);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard can be refused in an in-app browser; the link stays tappable.
    }
  };

  return (
    <>
      <button className={className} disabled={isPending} onClick={onClick}>
        {children(isPending)}
      </button>
      {/* Portalled: the header's backdrop blur makes it the containing block
          for anything fixed inside it, which pinned the sheet to the header. */}
      {help &&
        createPortal(
          <Sheet
            open={help}
            onClose={() => setHelp(false)}
            title="Open this page in your wallet"
          >
            <p className="text-[14px] leading-relaxed text-ink-2">
              This browser has no wallet in it, so there is nothing to connect.
              Open the same page in your wallet app&apos;s browser and connect
              there.
            </p>
            <div className="mt-4 grid gap-2">
              <a className="btn-primary w-full" href={links.metamask}>
                Open in MetaMask <Icon name="open_in_new" size={16} />
              </a>
              <a className="btn-soft w-full" href={links.trust}>
                Open in Trust Wallet <Icon name="open_in_new" size={16} />
              </a>
              <button className="btn-ghost w-full" onClick={copy}>
                {copied ? (
                  <>
                    <Icon name="check_circle" size={16} /> Link copied
                  </>
                ) : (
                  "Copy link"
                )}
              </button>
            </div>
            <p className="mt-3 text-[12px] leading-snug text-ink-3">
              Another wallet? Copy the link and open it in that wallet&apos;s
              browser.
            </p>
          </Sheet>,
          document.body,
        )}
    </>
  );
}
