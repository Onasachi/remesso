// deno test --unstable-sloppy-imports web/lib/phone.test.ts
//
// Pins how a typed number becomes what ODIS is asked about and what we store.
// A country is never guessed: "0803…" is a different person in every country,
// and a wrong guess resolves to a stranger's MiniPay wallet.
import { assertEquals } from "jsr:@std/assert@1";
import { findPhone, maskPhone, toE164 } from "./phone.ts";

Deno.test("toE164 accepts international forms and drops punctuation", () => {
  assertEquals(toE164("+234 803 123 4567"), "+2348031234567");
  assertEquals(toE164("00234-803-123-4567"), "+2348031234567");
  assertEquals(toE164("(+1) 415.555.2671"), "+14155552671");
});

Deno.test("toE164 reads a local number in the country the sender picked", () => {
  assertEquals(toE164("0706 765 1245", "NG"), "+2347067651245");
  assertEquals(toE164("024 412 3456", "GH"), "+233244123456");
  assertEquals(toE164("0712 345678", "KE"), "+254712345678");
  // A typed + wins over the picker: they told us the country themselves.
  assertEquals(toE164("+234 706 765 1245", "KE"), "+2347067651245");
  assertEquals(toE164("0706 765", "NG"), null); // too short for Nigeria
});

Deno.test("toE164 refuses what it would have to guess", () => {
  assertEquals(toE164("08031234567"), null);
  assertEquals(toE164("+0123456789"), null);
  assertEquals(toE164("+12"), null);
});

Deno.test("maskPhone keeps enough to recognise, not enough to dial", () => {
  assertEquals(maskPhone("+2348031234567"), "+234 803 ••• 4567");
  assertEquals(maskPhone("+14155552671"), "+1 415 ••• 2671");
  assertEquals(maskPhone("+233244123456"), "+233 244 ••• 3456");
});

Deno.test("findPhone picks the number out and never an amount", () => {
  const f = findPhone("Send 20 USDT to +234 706 765 1245 every month for 6 months");
  assertEquals(f?.raw, "+234 706 765 1245");
  assertEquals(f?.redacted, "Send 20 USDT to [recipient] every month for 6 months");
  assertEquals(findPhone("send 07067651245 5000 USDT weekly")?.raw, "07067651245");
  assertEquals(findPhone("Send 1500 USDT every 2 weeks for 12 transfers"), null);
  assertEquals(findPhone("Send 5 USDT to 0x2e2729F897D4E5799ADe12B3D911b40BA0307Aa4 weekly"), null);
});
