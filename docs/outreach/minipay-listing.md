# MiniPay listing — Remesso

**Subject:** Mini App listing request — Remesso (recurring payments home, in stablecoins)

Hi MiniPay team,

I'd like to submit **Remesso** for listing as a MiniPay Mini App.

**Remesso lets someone send money home on a schedule.** They set it up once
— who, how much, how often — and it pays automatically every week or month,
straight from their MiniPay balance to the person they're supporting. School
fees every term, rent every month, a parent's allowance every week: decided
once, never forgotten.

### Listing details

| | |
|---|---|
| Developer / company | Cracked Studio |
| Contact email | [your email] |
| App URL | https://remesso.crackedstudios.xyz |
| Category | Payments |
| Short description | Send money home on a schedule: set it once, and the person you support is paid every week or month from your MiniPay balance. |
| Already supports MiniPay | Yes, built for MiniPay first and tested in developer mode |
| Smart contract | `RemessoExecutorV5` `0x3C357af3300f383Ea49B6D6ED8e084199a92bEd8` on Celo mainnet, verified on Celoscan |
| Audited | **Not yet.** It is live and has paid real schedules from our own test wallets. We keep per-payment limits low until an audit. |
| Social | [X / Telegram handle] |
| Demo video | https://youtu.be/AD8JhgAlb9c |

### Why it fits MiniPay

- **One decision, then nothing to do.** Most remittance apps make you come
  back and send again every month. Remesso is set once, and the payments
  then happen on their own. It is a short session that keeps working
  afterwards.
- **It is for MiniPay's own users.** People supporting family in Nigeria,
  Ghana, Kenya and across Africa, in the stablecoins they already hold.
- **The recipient sees it in MiniPay.** Payments arrive as USDT, USDC or
  USDm, so the person being paid sees the money in their own MiniPay balance.

### How it meets MiniPay's rules

- **No wallet addresses anywhere.** The recipient is a **MiniPay contact**
  (through `minipay_requestContact`) or a **phone number**. Numbers are
  resolved through Celo's ODIS and FederatedAttestations, trusting only
  MiniPay's issuer. No address is displayed, copied or typed inside MiniPay,
  truncated forms included. Only a masked number is stored
  (`+234 706 ••• 1245`).
- **USDT supported**, plus USDC and USDm. Inside MiniPay, Remesso offers
  MiniPay's tokens only, and never shows or asks for CELO.
- **No message signing.** It uses no `personal_sign` and no
  `eth_signTypedData`. A schedule is created with two ordinary transactions
  (`approve`, then `createSchedule`), and everything else reads the connected
  account.
- **Connects automatically** inside MiniPay, with no connect button.
- **Clear transaction states.** Each step shows saving, approving in your
  wallet, signing and confirming. Failures are explained in plain words
  mapped from error codes.
- **Short of funds?** The app says how much is missing and links MiniPay's
  **Add cash**.
- **Phone numbers never reach the AI helper.** "Send 20 USDT to +234 … every
  month" fills the form, but the number is removed in the browser before
  anything is sent to a language model.

### Safety

The sender keeps their money until each payment goes out. The contract can
only pay the person, amount and rhythm they signed. Nobody can redirect or
raise a payment, us included. The sender can pause or cancel at any time,
and our agent checks upcoming payments a day ahead and warns the sender
before one would fail.

### A question for you

MiniPay's own **Deposit** screen lists **USDT, USDC, USDm and USAT**, so
Remesso currently offers USA₮ inside MiniPay as a fourth option. The
developer docs list three tokens. **Should a Mini App offer USA₮?** We will
follow your answer either way.

### Support

[Telegram / WhatsApp / email support link], linked from inside the app. We
commit to fixing critical issues within 24 hours.

Screenshots, a PageSpeed Insights report, and our Terms of Service and
Privacy Policy are attached or linked below. Happy to walk you through it on
a call.

Thank you,
[Your name]
Cracked Studio · Remesso
