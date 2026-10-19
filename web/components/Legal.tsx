import type { ReactNode } from "react";

/// Layout for /terms and /privacy. Plain server-rendered text, readable in
/// MiniPay's webview and by the plugin directory's link checker alike.

export const LEGAL_UPDATED = "October 19, 2026";
export const LEGAL_CONTACT = "support@crackedstudios.xyz";

export function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <article className="mt-8 pb-16 text-[15px] leading-relaxed text-ink-2">
      <h1 className="font-display text-[34px] leading-[1.05] text-ink">{title}</h1>
      <p className="mt-2 text-[13px] text-ink-3">Last updated: {LEGAL_UPDATED}</p>
      <div className="mt-6 space-y-4">{intro}</div>
      <div className="mt-8 space-y-8">{children}</div>
    </article>
  );
}

export function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-[18px] font-medium text-ink">
        {n}. {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

export function Mail() {
  return (
    <a className="text-ink underline" href={`mailto:${LEGAL_CONTACT}`}>
      {LEGAL_CONTACT}
    </a>
  );
}
