"use client";

import { useAccount } from "wagmi";
import { useAllowedDirectTokens, useIsMiniPay } from "@/lib/hooks";
import { ripioRampUrl } from "@/lib/ripio";

const COUNTRY_NAME: Record<string, string> = { ARS: "Argentina", BRL: "Brazil", COP: "Colombia" };

/// Ripio's buy ramp on the home screen, so a sender can get pesos or reais
/// BEFORE starting a schedule, not discover halfway through the form that they
/// hold none. The form keeps its own link (RecipientStep's RipioLinks) for
/// whoever goes straight there.
///
/// The wallet's address rides in the link, so what Ripio sells lands in the
/// wallet the schedule will pay from. Tokens come from the contract's
/// allowlist, like the form's picker: nothing is offered to buy that a
/// schedule could not then use. Hidden inside MiniPay, which shows none of
/// these tokens and has its own "Add money".
export function BuyLocal() {
  const { address } = useAccount();
  const inMiniPay = useIsMiniPay();
  const links = useAllowedDirectTokens()
    .map((t) => ({ t, url: ripioRampUrl("on", t, { address }) }))
    .filter((x): x is { t: typeof x.t; url: string } => x.url !== null);
  if (inMiniPay || !links.length) return null;

  return (
    <section className="card mt-4">
      <p className="text-[15px] font-medium text-ink">Paying in pesos or reais?</p>
      <p className="mt-0.5 text-[14px] leading-relaxed text-ink-2">
        Buy them first with Ripio, from a local bank account. They arrive in this wallet, and then
        you set up the schedule.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {links.map(({ t, url }) => (
          <a
            key={t.symbol}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-soft btn-sm"
          >
            Buy {t.symbol}
            <span className="ml-1 text-ink-3">· {COUNTRY_NAME[t.currency] ?? t.currency}</span>
          </a>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-ink-3">
        Opens Ripio's site. Ripio does its own checks; Remesso never sees your bank details.
      </p>
    </section>
  );
}
