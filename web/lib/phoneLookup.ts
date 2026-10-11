"use client";

import { ensureSession } from "./supabase";

/// Ask our server which MiniPay wallet a number belongs to. Shared by the
/// phone field and the "say it" box, so both meet the same meter and the
/// same refusals. The address is for signing with, never for rendering.
export async function lookupPhone(
  e164: string,
): Promise<{ found: false } | { found: true; address: `0x${string}`; masked: string }> {
  const token = await ensureSession();
  const res = await fetch("/api/resolve-phone", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ phone: e164 }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Could not look up that number. Try again.");
  return json;
}
