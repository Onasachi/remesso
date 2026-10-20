/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `/.well-known/agent.json` is where an agent handed only this origin will
  // look. It cannot be an app route directly: the App Router ignores path
  // segments beginning with a dot, so the handler lives at /api/agent-card
  // and is rewritten onto the conventional path.
  async rewrites() {
    return [
      { source: "/.well-known/agent.json", destination: "/api/agent-card" },
      // The connector's sign-in discovery (RFC 9728 and RFC 8414). Claude tries
      // the path-suffixed resource document first because the MCP URL has a path.
      { source: "/.well-known/oauth-protected-resource/mcp", destination: "/api/oauth/metadata?doc=resource" },
      { source: "/.well-known/oauth-protected-resource", destination: "/api/oauth/metadata?doc=resource" },
      { source: "/.well-known/oauth-authorization-server", destination: "/api/oauth/metadata?doc=server" },
    ];
  },
  // The phone lookup's SDK (web3 1.x, BLS wasm) is loaded by Node as-is
  // rather than bundled; webpack mangles its dynamic requires.
  experimental: {
    serverComponentsExternalPackages: ["@celo/identity", "@celo/contractkit"],
  },
  // wagmi/viem declare optional peer deps for React Native and pino that Next
  // tries to resolve at build time and that we never use.
  webpack: (config) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};
export default nextConfig;
