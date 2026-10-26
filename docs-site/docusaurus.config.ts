import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// The documentation site for remesso-sdk. Runs in Node at build time: no
// browser APIs or JSX here.
//
// Addresses, tokens and limits on these pages are never typed by hand. They
// render from src/data/deployment.json, a copy of deployments/celo-mainnet.json
// that scripts/build-docs-data.ts writes and checks.

const REPO = "https://bitbucket.org/crackedstudios/remesso";

const config: Config = {
  title: "Remesso SDK",
  tagline: "Recurring and agent payments on Celo, in TypeScript.",
  favicon: "img/favicon.svg",

  future: {
    v4: true,
  },

  url: "https://docs.remesso.xyz",
  baseUrl: "/",

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

  themes: [
    "@docusaurus/theme-mermaid",
    [
      "@easyops-cn/docusaurus-search-local",
      {
        hashed: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: "/docs",
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          showLastUpdateTime: false,
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: "img/social-card.png",
    metadata: [
      { name: "keywords", content: "remesso, celo, stablecoin, recurring payments, agent payments, typescript, sdk, viem" },
    ],
    colorMode: {
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
      },
    },
    navbar: {
      title: "Remesso",
      logo: {
        alt: "Remesso",
        src: "img/logo.svg",
        srcDark: "img/logo-dark.svg",
      },
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/docs/guides/schedules", label: "Guides", position: "left", activeBaseRegex: "/docs/guides/" },
        { to: "/docs/use-cases", label: "Use cases", position: "left", activeBaseRegex: "/docs/use-cases" },
        { to: "/docs/reference/client", label: "API reference", position: "left", activeBaseRegex: "/docs/reference/" },
        { to: "/docs/build-with-ai", label: "Build with AI", position: "left" },
        { href: "https://www.npmjs.com/package/remesso-sdk", label: "npm", position: "right" },
        { href: REPO, label: "Source", position: "right" },
        { href: "https://remesso.xyz", label: "Remesso app", position: "right" },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Start",
          items: [
            { label: "Introduction", to: "/docs" },
            { label: "Quickstart", to: "/docs/quickstart" },
            { label: "Core concepts", to: "/docs/concepts" },
          ],
        },
        {
          title: "Build",
          items: [
            { label: "Guides", to: "/docs/guides/schedules" },
            { label: "Use cases", to: "/docs/use-cases" },
            { label: "API reference", to: "/docs/reference/client" },
            { label: "Build with AI", to: "/docs/build-with-ai" },
          ],
        },
        {
          title: "Remesso",
          items: [
            { label: "Remesso app", href: "https://remesso.xyz" },
            { label: "Developer page", href: "https://remesso.xyz/developers" },
            { label: "Capability document", href: "https://engaboljiqudghvzmebq.supabase.co/functions/v1/agent" },
          ],
        },
        {
          title: "Code",
          items: [
            { label: "remesso-sdk on npm", href: "https://www.npmjs.com/package/remesso-sdk" },
            { label: "Source", href: REPO },
            { label: "Example agents", href: `${REPO}/src/main/examples/` },
          ],
        },
      ],
      copyright: "remesso-sdk is MIT licensed.",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ["bash", "json", "diff"],
    },
    mermaid: {
      theme: { light: "neutral", dark: "dark" },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
