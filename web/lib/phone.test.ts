// deno test --unstable-sloppy-imports web/lib/phone.test.ts
//
// Pins how a typed number becomes what ODIS is asked about and what we store.
// A country is never guessed: "0803…" is a different person in every country,
// and a wrong guess resolves to a stranger's MiniPay wallet.
import { assertEquals } from "jsr:@std/assert@1";
import { maskPhone, toE164 } from "./phone.ts";

Deno.test("toE164 accepts international forms and drops punctuation", () => {
  assertEquals(toE164("+234 803 123 4567"), "+2348031234567");
  assertEquals(toE164("00234-803-123-4567"), "+2348031234567");
  assertEquals(toE164("(+1) 415.555.2671"), "+14155552671");
});

Deno.test("toE164 refuses what it would have to guess", () => {
  assertEquals(toE164("08031234567"), null);
  assertEquals(toE164("+0123456789"), null);
  assertEquals(toE164("+12"), null);
});

Deno.test("maskPhone keeps enough to recognise, not enough to dial", () => {
  assertEquals(maskPhone("+2348031234567"), "+234 803 ••• 4567");
  assertEquals(maskPhone("+14155552671"), "+141 555 ••• 2671");
});
