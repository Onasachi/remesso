/// Tables of what Remesso runs on Celo mainnet, rendered from the deployment
/// manifest (src/data/deployment.json, copied by scripts/build-docs-data.ts)
/// so no address, decimal or limit on these pages is typed by hand.
import type { ReactNode } from "react";
import deployment from "@site/src/data/deployment.json";

type TokenRow = (typeof deployment.tokens)[number];

const EXPLORER = "https://celoscan.io/address/";

/// Base units as a decimal, with thousands separators: "1,500,000".
function amount(base: string, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const value = BigInt(base);
  const whole = (value / unit).toLocaleString("en-US");
  const frac = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function Address({ value }: { value: string }): ReactNode {
  return (
    <a href={`${EXPLORER}${value}`} target="_blank" rel="noreferrer">
      <code>{value}</code>
    </a>
  );
}

function Wrap({ children }: { children: ReactNode }): ReactNode {
  return <div className="rm-table-wrap">{children}</div>;
}

/// Every token a schedule can pay in, with the executor's per-payment bounds.
export function TokenTable(): ReactNode {
  return (
    <Wrap>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Currency</th>
            <th>Decimals</th>
            <th>Per payment, before the fee</th>
            <th>Pays gas</th>
            <th>Address</th>
          </tr>
        </thead>
        <tbody>
          {deployment.tokens.map((t: TokenRow) => (
            <tr key={t.address}>
              <td>
                <strong>{t.symbol}</strong>
              </td>
              <td>{t.currency}</td>
              <td>{t.decimals}</td>
              <td>
                {amount(t.minPerRun, t.decimals)} to {amount(t.maxPerRun, t.decimals)}
              </td>
              <td>{t.feeCurrency ? "Yes" : "No"}</td>
              <td>
                <Address value={t.address} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrap>
  );
}

/// The chain the SDK signs for, and nothing else.
export function ChainTable(): ReactNode {
  const c = deployment.chain;
  return (
    <Wrap>
      <table>
        <tbody>
          <tr>
            <th>Network</th>
            <td>{c.name} mainnet</td>
          </tr>
          <tr>
            <th>Chain id</th>
            <td>
              <code>{c.chainId}</code> (<code>{c.caip2}</code>)
            </td>
          </tr>
          <tr>
            <th>Default RPC</th>
            <td>
              <code>{c.rpc}</code>
            </td>
          </tr>
        </tbody>
      </table>
    </Wrap>
  );
}

/// The contracts, with what each one pins.
export function ContractTable(): ReactNode {
  const v5 = deployment.contracts.RemessoExecutorV5;
  const allowance = deployment.contracts.RemessoAgentAllowance;
  const registry = deployment.contracts.ERC8004IdentityRegistry;
  return (
    <Wrap>
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Address</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>RemessoExecutorV5</strong>
            </td>
            <td>
              <Address value={v5.address} />
            </td>
            <td>
              Holds every schedule. Commission {v5.feeBps / 100}% ({v5.feeBps} bps), pinned per schedule when it is
              signed. Deployed at block {v5.deployBlock.toLocaleString("en-US")}.
            </td>
          </tr>
          <tr>
            <td>
              <strong>RemessoAgentAllowance</strong>
            </td>
            <td>
              <Address value={allowance.address} />
            </td>
            <td>
              Agent spending policies: a cap per payment and per day, an expiry, an optional recipient list. No owner,
              no admin. Deployed at block {allowance.deployBlock.toLocaleString("en-US")}.
            </td>
          </tr>
          <tr>
            <td>
              <strong>ERC-8004 identity registry</strong>
            </td>
            <td>
              <Address value={registry.address} />
            </td>
            <td>Where agents are registered; the SDK reads an agent's wallet from it.</td>
          </tr>
          <tr>
            <td>
              <strong>Executor key</strong>
            </td>
            <td>
              <Address value={v5.executor} />
            </td>
            <td>Remesso's hot key, which sends each payment when it is due. It pays gas and nothing else.</td>
          </tr>
          <tr>
            <td>
              <strong>Trigger sentinel</strong>
            </td>
            <td>
              <code>{v5.currentExecutorSentinel}</code>
            </td>
            <td>
              Grant this as a schedule's trigger to let Remesso's executor, whichever key it is at the time, bring a
              payment forward.
            </td>
          </tr>
        </tbody>
      </table>
    </Wrap>
  );
}

const ENDPOINTS: Record<string, string> = {
  agent: "The capability document: identity, chain, limits, prices and refusals. Free.",
  "request-payment": "Payment requests: create, status, list, answer, decline. Free.",
  "payment-events": "Every payment to or from an address, as Remesso's indexer reads it from the chain. Free.",
  webhooks: "Subscribe an address's payments to your endpoint, signed. Free.",
  "trigger-run": "Bring one payment of a schedule forward, paid over x402.",
  "rate-service": "USDT/NGN and USDC/NGN rates, paid over x402.",
  "latam-rate": "USD to wARS and wBRL rates, paid over x402.",
  "latam-route": "A route for delivering pesos or reais, paid over x402.",
};

/// Remesso's HTTP endpoints. The SDK calls the first four for you.
export function EndpointTable(): ReactNode {
  const fns = deployment.functions as Record<string, string>;
  return (
    <Wrap>
      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(ENDPOINTS)
            .filter((name) => fns[name])
            .map((name) => (
              <tr key={name}>
                <td>
                  <code>{fns[name]}</code>
                </td>
                <td>{ENDPOINTS[name]}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </Wrap>
  );
}

/// The fee as a percentage, from the manifest: "0.25%".
export function FeePercent(): ReactNode {
  return <>{deployment.contracts.RemessoExecutorV5.feeBps / 100}%</>;
}
