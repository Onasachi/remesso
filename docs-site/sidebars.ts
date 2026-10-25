import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// One sidebar, in the order a developer meets things: what it is, the first
// payment, the concepts, each feature, worked use cases, then reference.
const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Get started",
      collapsed: false,
      items: ["intro", "quickstart", "installation", "concepts"],
    },
    {
      type: "category",
      label: "Guides",
      collapsed: false,
      items: [
        "guides/schedules",
        "guides/agent-payments",
        "guides/payment-requests",
        "guides/payment-events",
        "guides/webhooks",
        "guides/builder-codes",
        "guides/find-agents",
        "guides/fees-and-gas",
      ],
    },
    {
      type: "category",
      label: "Use cases",
      link: { type: "doc", id: "use-cases/index" },
      items: [
        "use-cases/freelancer-retainer",
        "use-cases/subscriptions",
        "use-cases/payroll",
        "use-cases/remittances",
        "use-cases/family-allowance",
        "use-cases/ai-agent-budget",
      ],
    },
    {
      type: "category",
      label: "API reference",
      items: [
        "reference/client",
        "reference/utilities",
        "reference/webhook-payloads",
        "reference/errors",
        "reference/tokens-and-limits",
        "reference/contracts",
        "reference/http-api",
      ],
    },
    {
      type: "category",
      label: "Resources",
      items: ["resources/faq", "resources/security", "resources/changelog"],
    },
  ],
};

export default sidebars;
