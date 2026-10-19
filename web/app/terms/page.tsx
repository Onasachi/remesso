import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, List, Mail, Section } from "@/components/Legal";

export const metadata: Metadata = { title: "Terms of Service · Remesso" };

/// Adapted from Cracked Studio's terms for its other services, rewritten for
/// what Remesso actually does: non-custodial scheduled payments on Celo, an
/// executor that can only act inside a mandate the user signed, and the Claude
/// plugin's agent wallet. Not reviewed by a lawyer as of the date above.
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <>
          <p>
            Cracked Studio (&quot;Cracked Studio,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) builds and
            operates Remesso, a service for sending stablecoin payments on the Celo blockchain on a schedule, available
            at remesso.crackedstudios.xyz, inside MiniPay, through our public APIs, and through the Remesso plugin for
            Claude (together, the &quot;Services&quot;).
          </p>
          <p>
            These Terms of Service (the &quot;Terms&quot;) are a legally binding agreement between you and Cracked
            Studio. By accessing or using the Services you agree to them. If you do not agree, do not use the Services.
          </p>
        </>
      }
    >
      <Section n={1} title="Definitions">
        <List
          items={[
            <>&quot;Wallet&quot; means a blockchain wallet you control, such as MiniPay or a browser wallet.</>,
            <>
              &quot;Schedule&quot; or &quot;mandate&quot; means a recurring payment you authorise on-chain: the
              recipient, token, amount, how often, and until when.
            </>,
            <>
              &quot;Smart contracts&quot; means the Remesso contracts on Celo that hold the rules of each Schedule and
              agent spending policy, including RemessoExecutorV5 and RemessoAgentAllowance.
            </>,
            <>
              &quot;Agent&quot; means the automated system that sends due payments under your Schedules, and, where you
              use the Claude plugin, the agent wallet on your own device.
            </>,
            <>&quot;User&quot; or &quot;you&quot; means any person who accesses or uses the Services.</>,
          ]}
        />
      </Section>

      <Section n={2} title="Eligibility">
        <p>
          You must be at least 18 years old and able to form a binding contract to use the Services. You may not use
          the Services if you are subject to sanctions, or located in a country or region where using them is
          prohibited by law.
        </p>
      </Section>

      <Section n={3} title="What Remesso does, and does not do">
        <List
          items={[
            <>
              <strong>Non-custodial.</strong> Remesso never holds your funds. Each payment moves directly from your
              Wallet to the recipient&apos;s, through an allowance you grant to a smart contract and can revoke at any
              time from your Wallet.
            </>,
            <>
              <strong>Only what you signed.</strong> The Agent can send a payment only when it is due and only within
              the terms you authorised on-chain. Nobody, including Cracked Studio, can redirect, enlarge or extend a
              payment. You can pause, resume or cancel a Schedule from your Wallet.
            </>,
            <>
              <strong>No conversion.</strong> On the payment rail available today, the recipient receives the same
              token you fund the Schedule with. Remesso does not exchange currencies or pay out to bank accounts.
            </>,
            <>
              <strong>Not a bank.</strong> Remesso is not a bank, does not take deposits, and does not offer
              investment, lending or credit products. Stablecoins are not legal tender and are not insured by any
              government scheme.
            </>,
          ]}
        />
      </Section>

      <Section n={4} title="Your responsibilities">
        <List
          items={[
            "Keeping your Wallet, its private keys and recovery phrase secure. We cannot recover them or reverse anything signed with them.",
            "Checking the recipient, token, amount and timing before you sign. Blockchain payments are final once confirmed.",
            "Keeping enough funds and allowance in your Wallet for each payment, and enough gas where required.",
            "Using the Services lawfully, including the tax, reporting and foreign-exchange rules that apply to you.",
          ]}
        />
      </Section>

      <Section n={5} title="Fees">
        <p>
          Remesso charges a commission on each scheduled payment, currently 0.25%, fixed in the Schedule when you sign
          it and shown before you sign. Paid services sold to software agents over x402 show their price before
          payment. Blockchain network fees are separate. We may change fees for new Schedules; a change never applies to
          a Schedule you have already signed.
        </p>
      </Section>

      <Section n={6} title="Phone numbers and recipients in MiniPay">
        <p>
          Inside MiniPay you can choose a recipient by phone number or from your contacts. We look up the MiniPay
          wallet registered to that number through Celo&apos;s identity service. A Schedule pays one wallet address:
          if the recipient later moves their number to a different wallet, payments continue to the original address.
          It is your responsibility to confirm the recipient is who you intend.
        </p>
      </Section>

      <Section n={7} title="The Remesso plugin for Claude and agent wallets">
        <List
          items={[
            "The plugin creates an agent key on your own device. We never receive it and cannot recover it.",
            "The agent can spend from your Wallet only within a spending policy you create on-chain: a token, a cap per payment, a daily cap, a total, and an expiry. You can stop it at any time.",
            "You are responsible for the policies you create and for the instructions you give the AI assistant. An AI assistant can make mistakes; keep limits small.",
          ]}
        />
      </Section>

      <Section n={8} title="AI features">
        <p>
          Some features use AI models, for example to draft a Schedule from a sentence or to classify why a payment did
          not go through. These suggestions are advisory: nothing is sent until you review and sign it in your Wallet.
          Do not rely on them as financial, legal or tax advice.
        </p>
      </Section>

      <Section n={9} title="Third-party services">
        <p>
          The Services rely on and link to services we do not control, including the Celo blockchain, MiniPay, wallet
          providers, Celo&apos;s x402 facilitator, Self, Ripio, Textile and Noblocks. Your use of them is subject to
          their own terms and privacy policies, and we are not responsible for their availability, actions or fees.
          Links to buy, sell or cash out tokens are provided for convenience; the transaction is between you and that
          provider.
        </p>
      </Section>

      <Section n={10} title="Risks you accept">
        <List
          items={[
            "Smart contracts can contain errors. The Remesso contracts are tested but have not been audited by an independent firm.",
            "A stablecoin can lose its peg, be frozen by its issuer, or become unavailable.",
            "Blockchain networks can be congested, delayed or changed, and a payment can fail or arrive late.",
            "Regulation of digital assets can change and may limit or end the Services in some places.",
          ]}
        />
      </Section>

      <Section n={11} title="Prohibited use">
        <p>You must not use the Services to:</p>
        <List
          items={[
            "send or receive proceeds of crime, finance terrorism, or evade sanctions;",
            "defraud, deceive or harass anyone, including by sending payment requests or links meant to mislead;",
            "interfere with, overload, probe or attack the Services, the smart contracts or other users;",
            "use bots or automation against the Services in a way not offered through our documented APIs and plugin;",
            "infringe anyone's rights or break any applicable law.",
          ]}
        />
      </Section>

      <Section n={12} title="Intellectual property">
        <p>
          The Remesso source code is published under the MIT License, and your use of the code is governed by that
          license. The Remesso name, logo and the content of our websites remain the property of Cracked Studio.
        </p>
      </Section>

      <Section n={13} title="Personal data">
        <p>
          Our <Link className="text-ink underline" href="/privacy">Privacy Policy</Link> explains what we collect and
          how we use it.
        </p>
      </Section>

      <Section n={14} title="Disclaimer and limitation of liability">
        <p className="uppercase">
          To the maximum extent permitted by applicable law, the Services are provided &quot;as is&quot; and &quot;as
          available&quot;, without warranties of any kind, whether express, implied or statutory, including warranties
          of merchantability, fitness for a particular purpose, title and non-infringement. We do not warrant that the
          Services will be uninterrupted, error-free or secure.
        </p>
        <p className="uppercase">
          To the maximum extent permitted by applicable law, Cracked Studio and its affiliates, directors, officers,
          employees, agents and licensors shall not be liable for any indirect, incidental, special, consequential,
          punitive or exemplary damages, or for any loss of profits, goodwill, data or digital assets, arising out of or
          in connection with your use of or inability to use the Services.
        </p>
      </Section>

      <Section n={15} title="Suspension and termination">
        <p>
          You may stop using the Services at any time by cancelling your Schedules and revoking your allowances in your
          Wallet. We may stop operating the Agent for a Schedule, stop offering a feature, or restrict access if you
          breach these Terms, if we suspect fraud, abuse or unlawful activity, or if the law requires it. Because the
          Services are non-custodial, this never affects funds held in your Wallet.
        </p>
      </Section>

      <Section n={16} title="Governing law and disputes">
        <p>
          These Terms are governed by the laws of the Federal Republic of Nigeria. If you have a concern, contact us at{" "}
          <Mail /> and we will try to resolve it amicably. If a dispute is not resolved within 30 days, either party may
          refer it to arbitration administered by the Nigerian Institute of Chartered Arbitrators under its rules, in
          English.
        </p>
      </Section>

      <Section n={17} title="General">
        <List
          items={[
            "These Terms and our Privacy Policy are the entire agreement between you and us about the Services.",
            "If any provision is held invalid, the rest remains in effect.",
            "Our not enforcing a provision is not a waiver of it.",
            "We may assign these Terms in connection with a merger, acquisition or sale of assets.",
            "These Terms are written in English, and the English version prevails over any translation.",
            "We may update these Terms. We will change the date above, and material changes will be shown in the app. Continuing to use the Services after an update means you accept it.",
          ]}
        />
      </Section>

      <Section n={18} title="Contact">
        <p>
          Questions about these Terms: <Mail />.
        </p>
      </Section>
    </LegalPage>
  );
}
