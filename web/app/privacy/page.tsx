import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, List, Mail, Section } from "@/components/Legal";

export const metadata: Metadata = { title: "Privacy Policy · Remesso" };

/// What Remesso collects, written from the schema and the code, not from a
/// template: every claim here should be checkable against supabase/migrations
/// and the functions. Change this page when either changes what is stored.
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <p>
          Cracked Studio (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) operates Remesso. This policy explains
          what information we handle when you use Remesso on the web, inside MiniPay, through our APIs, or through the
          Remesso plugin for Claude, and the choices you have. Remesso does not ask for your name, email address or
          password, and never has access to your wallet&apos;s private keys.
        </p>
      }
    >
      <Section n={1} title="Information we store">
        <List
          items={[
            <>
              <strong>Your wallet address</strong>, linked to an anonymous session created when you open the app, so
              we can show you your schedules.
            </>,
            <>
              <strong>Your schedules</strong>: the recipient&apos;s wallet address, the name you give them (&quot;Who
              is this for?&quot;), token, amount, how often, the end date, a label, and the status and history of each
              payment, including transaction hashes.
            </>,
            <>
              <strong>A masked phone number</strong> when you pay someone by phone number in MiniPay, for example
              +234 706 ••• 1245. We do not store or log the full number.
            </>,
            <>
              <strong>Identity check results</strong>, only if you choose to verify with Self: whether the check passed
              (over 18, not on a sanctions list), the environment, and an anonymous identifier Self issues to prevent
              one passport verifying many accounts. We do not receive your name, date of birth, nationality or passport
              details.
            </>,
            <>
              <strong>Payment requests</strong> that anyone sends to a wallet address: the payer&apos;s and
              recipient&apos;s addresses, the proposed amount, token, frequency, and the optional name and note the
              requester provides.
            </>,
            <>
              <strong>Notices and usage counters</strong>: reminders our system creates about upcoming payments, and a
              count of phone-number lookups per session per day, used to limit them.
            </>,
          ]}
        />
      </Section>

      <Section n={2} title="Public blockchain data">
        <p>
          Schedules, payments, agent spending policies and allowances are recorded on the Celo blockchain. Blockchain
          data is public and permanent: anyone can see the addresses, amounts and times involved, and neither we nor
          anyone else can delete it. We also read public blockchain data, such as balances and allowances, to check
          whether a payment will succeed and to show your history.
        </p>
      </Section>

      <Section n={3} title="How we use information">
        <List
          items={[
            "to create, display and carry out the payments you authorise;",
            "to warn you before a payment would fail, and to explain why one did not go through;",
            "to find the MiniPay wallet that belongs to a phone number you enter;",
            "to prevent fraud and abuse, and to keep the Services secure;",
            "to comply with the law.",
          ]}
        />
        <p>We do not sell your information, and we do not use it for advertising.</p>
      </Section>

      <Section n={4} title="Who we share it with">
        <List
          items={[
            <>
              <strong>Celo&apos;s identity service (ODIS) and the Celo blockchain</strong>, to look up the wallet for a
              phone number. The number is sent from our server for that lookup only.
            </>,
            <>
              <strong>AI providers.</strong> When you describe a payment in a sentence, the sentence is sent to
              DeepSeek to draft the form. Phone numbers are removed in your browser before it is sent. Payment details
              and failure reasons may be sent to TypeSafe to classify them. These providers process the text to return
              a result.
            </>,
            <>
              <strong>Infrastructure providers</strong> that host and run Remesso, including Supabase (database and
              server functions), Vercel (website) and Goldsky (indexing of public blockchain data). They process data on
              our behalf.
            </>,
            <>
              <strong>Self</strong>, if you choose to verify your identity, under Self&apos;s own privacy policy.
            </>,
            <>
              <strong>Authorities</strong>, where the law requires it.
            </>,
          ]}
        />
        <p>
          Links to MiniPay, Ripio, Textile and other services take you to those services, which handle your information
          under their own policies.
        </p>
      </Section>

      <Section n={5} title="The Remesso plugin for Claude">
        <p>
          The plugin keeps its agent key and settings on your own device. We receive nothing from it except payment
          requests you choose to send. The details are in the{" "}
          <a
            className="text-ink underline"
            href="https://bitbucket.org/crackedstudios/remesso/src/main/plugin/PRIVACY.md"
            target="_blank"
            rel="noreferrer"
          >
            plugin privacy notice
          </a>
          .
        </p>
      </Section>

      <Section n={6} title="Stored on your device">
        <p>
          The app keeps a few preferences in your browser&apos;s local storage, such as the country you last chose for
          phone numbers, and a session token for the anonymous session. Clearing your browser data removes them.
        </p>
      </Section>

      <Section n={7} title="Retention and security">
        <p>
          We keep the information above while your schedules exist and for as long as needed to show your payment
          history, unless you ask us to delete it. We protect it with access controls, encryption in transit, and
          database rules that let each session read only its own data. No system is completely secure.
        </p>
      </Section>

      <Section n={8} title="Your rights">
        <p>
          Depending on where you live, you may have the right to access, correct or delete your information, or to
          object to how we use it. To ask, email <Mail /> from an address you control and tell us the wallet address
          involved. We cannot delete data recorded on the blockchain.
        </p>
      </Section>

      <Section n={9} title="Children">
        <p>Remesso is not intended for anyone under 18, and we do not knowingly collect information from them.</p>
      </Section>

      <Section n={10} title="International processing">
        <p>
          Our providers may process information in countries other than yours, including in the European Union and the
          United States.
        </p>
      </Section>

      <Section n={11} title="Changes">
        <p>
          We may update this policy. We will change the date above, and show material changes in the app. See also our{" "}
          <Link className="text-ink underline" href="/terms">
            Terms of Service
          </Link>
          .
        </p>
      </Section>

      <Section n={12} title="Contact">
        <p>
          Privacy questions: <Mail />.
        </p>
      </Section>
    </LegalPage>
  );
}
