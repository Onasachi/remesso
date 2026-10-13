"use client";

import { DIRECT_TOKENS } from "@/lib/config";
import { useIsMiniPay, useNotices } from "@/lib/hooks";
import { noticeText, type NoticeKind, type ScheduleNotice } from "@/lib/notices";
import { ReapproveButton } from "./Reapprove";
import { MINIPAY_DEPOSIT_URL } from "./ui";

/// What the pre-flight agent found wrong with upcoming payments, each with the
/// fix one tap away. Pass `scheduleId` to show one schedule's notices, and
/// `kinds` to show only some (the home screen leaves allowance to its own
/// strip, so the sender is not warned twice about the same thing).
export function Notices({ scheduleId, kinds }: { scheduleId?: string; kinds?: NoticeKind[] }) {
  const { data } = useNotices();
  const inMiniPay = useIsMiniPay();
  const shown = (data ?? []).filter(
    (x) => (!scheduleId || x.schedule_id === scheduleId) && (!kinds || kinds.includes(x.kind)),
  );
  if (!shown.length) return null;

  return (
    <div className="mt-3 space-y-3">
      {shown.map((x) => (
        <NoticeCard key={x.id} notice={x} inMiniPay={inMiniPay} />
      ))}
    </div>
  );
}

function NoticeCard({ notice, inMiniPay }: { notice: ScheduleNotice; inMiniPay: boolean }) {
  const { title, body } = noticeText(notice);
  const token = DIRECT_TOKENS.find((t) => t.symbol === notice.details.symbol);
  const tone = notice.severity === "info" ? "notice-info" : "notice-warn";

  return (
    <div className={tone}>
      <p className="font-medium text-ink">{title}</p>
      <p className="mt-0.5">{body}</p>
      {notice.kind === "balance_short" && inMiniPay && (
        <a href={MINIPAY_DEPOSIT_URL} className="btn-soft btn-sm mt-2 inline-flex">
          Add money
        </a>
      )}
      {(notice.kind === "allowance_short" || notice.kind === "allowance_ending") && token && (
        <div className="mt-2">
          <ReapproveButton token={token} label={notice.kind === "allowance_short" ? "Allow payments again" : "Allow more payments"} />
        </div>
      )}
      <p className="mt-2 text-[12px] text-ink-3">Checked by Remesso's agent before the payment is due.</p>
    </div>
  );
}
