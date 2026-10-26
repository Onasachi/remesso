/// Tables of what Remesso runs on Celo mainnet, rendered from the deployment
/// manifest (src/data/deployment.json, copied by scripts/build-docs-data.ts)
/// so no address, decimal or limit on these pages is typed by hand. The rows
/// come from deployment-rows.ts, which the Markdown for AI assistants is
/// written from too.
import type { ReactNode } from "react";
import deployment from "@site/src/data/deployment.json";
import { chainRows, contractRows, endpointRows, EXPLORER, feePercent, type Text, tokenRows } from "./deployment-rows";

function Address({ value }: { value: string }): ReactNode {
  return (
    <a href={`${EXPLORER}${value}`} target="_blank" rel="noreferrer">
      <code>{value}</code>
    </a>
  );
}

function Rich({ text }: { text: Text }): ReactNode {
  return <>{text.map((part, i) => (typeof part === "string" ? part : <code key={i}>{part.code}</code>))}</>;
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
          {tokenRows(deployment).map((t) => (
            <tr key={t.address}>
              <td>
                <strong>{t.symbol}</strong>
              </td>
              <td>{t.currency}</td>
              <td>{t.decimals}</td>
              <td>{t.perPayment}</td>
              <td>{t.paysGas ? "Yes" : "No"}</td>
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
  return (
    <Wrap>
      <table>
        <tbody>
          {chainRows(deployment).map((row) => (
            <tr key={row.label}>
              <th>{row.label}</th>
              <td>
                <Rich text={row.value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrap>
  );
}

/// The contracts, with what each one pins.
export function ContractTable(): ReactNode {
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
          {contractRows(deployment).map((row) => (
            <tr key={row.name}>
              <td>
                <strong>{row.name}</strong>
              </td>
              <td>{row.linked ? <Address value={row.address} /> : <code>{row.address}</code>}</td>
              <td>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrap>
  );
}

/// Remesso's HTTP endpoints. The SDK calls the first four for you.
export function EndpointTable(): ReactNode {
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
          {endpointRows(deployment).map((row) => (
            <tr key={row.url}>
              <td>
                <code>{row.url}</code>
              </td>
              <td>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Wrap>
  );
}

/// The fee as a percentage, from the manifest: "0.25%".
export function FeePercent(): ReactNode {
  return <>{feePercent(deployment)}</>;
}
