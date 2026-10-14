"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ConnectBar } from "./ConnectBar";
import { Icon } from "./Icon";

/// The header is contextual rather than a tab bar. There are only two places to
/// be — the list and one schedule — so on the list it is the wordmark, and
/// everywhere else it is a way back. Opay and Moniepoint users expect exactly
/// this shape; a persistent tab strip for two destinations is noise.
const TITLES: Array<[RegExp, string]> = [
  [/^\/schedules\/new/, "New schedule"],
  [/^\/schedules\/[^/]+/, "Schedule"],
];

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const title = TITLES.find(([re]) => re.test(pathname))?.[1];

  return (
    <header className="sticky top-0 z-20 bg-paper/85 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-md">
      <div className="flex h-10 items-center justify-between gap-3 whitespace-nowrap">
        {title ? (
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}
            className="-ml-2 flex min-h-11 items-center gap-1 rounded-xl pl-2 pr-3 text-[15px] font-medium text-ink transition hover:bg-sand active:scale-[0.98]"
            aria-label="Back"
          >
            <Icon name="chevron_left" size={22} />
            <span>{title}</span>
          </button>
        ) : (
          <Link href="/" className="font-display text-[26px] leading-none text-ink">
            Remesso
          </Link>
        )}
        {/* Sub-pages get the compact form: the name only. "Sign out" is a
            home-screen action, and at 360px the three do not fit on one line. */}
        <ConnectBar compact={Boolean(title)} />
      </div>
    </header>
  );
}
