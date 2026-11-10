/**
 * Spike E, part 1: registers one bit MCP endpoint through Pi's **built-in** MCP support
 * (`pi.registerMcpServer`, `docs/mcp.md` "Add servers from extensions"), to record what
 * Pi's client does against bit's stateless 2026-07-28 endpoint. Loaded with `pi -e`.
 */

interface PiMcpApi {
  registerMcpServer(
    name: string,
    config: { url: string; headers: Record<string, string>; exposure: string },
  ): void;
}

export default function builtinMcp(pi: PiMcpApi): void {
  const url = process.env.BIT_MCP_URL;
  const token = process.env.BIT_MCP_TOKEN;
  const name = process.env.BIT_MCP_SERVER ?? "bit";
  delete process.env.BIT_MCP_TOKEN;
  if (url === undefined || token === undefined) return;
  pi.registerMcpServer(name, {
    url,
    headers: { Authorization: `Bearer ${token}` },
    exposure: "direct",
  });
}
