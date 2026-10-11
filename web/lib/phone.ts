/// Phone numbers as MiniPay recipients — the parts both sides need.
///
/// ODIS takes E.164 only (`+2348031234567`) and refuses anything else, so a
/// number is normalised here before it is sent anywhere. No country is
/// guessed: a leading 0 means a different person in every country, and a
/// wrong guess resolves to a stranger's wallet.

/// `+` and 8–15 digits, the first not 0. Spaces, dashes, dots and brackets are
/// dropped; a leading `00` is the international prefix written longhand.
export function toE164(input: string): string | null {
  let s = input.trim().replace(/[\s\-().]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/// What a sender sees and what we store: enough to recognise the number,
/// not enough to dial it. `+234 803 ••• 4567`.
export function maskPhone(e164: string): string {
  const head = e164.slice(0, Math.min(7, e164.length - 4));
  const tail = e164.slice(-4);
  return `${head.slice(0, 4)} ${head.slice(4)} ••• ${tail}`.replace(/\s+/g, " ");
}
