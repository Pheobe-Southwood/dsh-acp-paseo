/**
 * MCP server admission for `session/new` / `session/load` / `session/fork`.
 * Mirrors the harness rules: unique normalized names, absolute stdio commands,
 * absolute http(s) URLs, validated env/headers, and session-cwd inheritance.
 * @module dsh-acp-plus/mcp
 */
import { createHash } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isAbsolute } from 'node:path';
import { ContentError } from './content.js';

export interface McpServerConfig {
  transport: 'stdio' | 'streamable-http';
  serverName: string;
  toolCallTimeoutMs: number;
  failOnStartupError: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

function normalizeServerName(original: string): string {
  if (NAME_PATTERN.test(original)) return original;
  const folded = original.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const digest = createHash('sha256').update(original).digest('hex').slice(0, 8);
  const head = (folded.slice(0, 20) || 'server').replace(/_+$/g, '') || 'server';
  return `${head}_${digest}`.slice(0, 32);
}

function assertEntry(record: Record<string, string>, kind: 'env' | 'header'): void {
  for (const [name, value] of Object.entries(record)) {
    if (name.length === 0 || name.includes('=') || name.includes('\0')) {
      throw new ContentError(`invalid MCP ${kind} name: ${JSON.stringify(name)}`);
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw new ContentError(`invalid MCP ${kind} value for ${name}`);
    }
    if (kind === 'header') {
      try {
        validateHeaderName(name);
        validateHeaderValue(name, value);
      } catch (error) {
        throw new ContentError(`invalid MCP header ${name}: ${(error as Error).message}`);
      }
    }
  }
}

function recordOf(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ContentError(`${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = String(entry);
  }
  return out;
}

/** Validate and translate ACP `mcpServers` entries into MCP client configs. */
export function resolveMcpConfigs(servers: unknown, sessionCwd: string): McpServerConfig[] {
  if (servers === undefined || servers === null) return [];
  if (!Array.isArray(servers)) throw new ContentError('mcpServers must be an array');
  const seen = new Set<string>();
  const configs: McpServerConfig[] = [];
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') throw new ContentError('invalid MCP server entry');
    const server = entry as Record<string, unknown>;
    const rawName = String(server.name ?? '');
    if (rawName.length === 0) throw new ContentError('MCP server name is required');
    const serverName = normalizeServerName(rawName);
    if (seen.has(serverName)) throw new ContentError(`duplicate MCP server name: ${rawName}`);
    seen.add(serverName);
    const timeout = Number(server.toolCallTimeoutMs);
    const toolCallTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TOOL_CALL_TIMEOUT_MS;
    const hasCommand = typeof server.command === 'string' && server.command.length > 0;
    const hasUrl = typeof server.url === 'string' && server.url.length > 0;
    if (hasCommand && hasUrl) throw new ContentError(`MCP server ${rawName} cannot define both command and url`);
    if (hasCommand) {
      const command = String(server.command);
      if (!isAbsolute(command)) throw new ContentError(`MCP server ${rawName} command must be absolute`);
      configs.push({
        transport: 'stdio',
        serverName,
        command,
        args: Array.isArray(server.args) ? server.args.map((arg) => String(arg)) : [],
        env: recordOf(server.env, 'env'),
        cwd: sessionCwd,
        toolCallTimeoutMs,
        failOnStartupError: true,
      });
      continue;
    }
    if (hasUrl) {
      const url = String(server.url);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new ContentError(`MCP server ${rawName} url is invalid`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ContentError(`MCP server ${rawName} url must be http(s)`);
      }
      configs.push({
        transport: 'streamable-http',
        serverName,
        url,
        headers: recordOf(server.headers, 'headers'),
        toolCallTimeoutMs,
        failOnStartupError: true,
      });
      continue;
    }
    throw new ContentError(`MCP server ${rawName} must define command or url`);
  }
  return configs;
}

/** Config object handed to `agentCtx.plugin(McpClient, config)`. */
export function mcpPluginConfig(config: McpServerConfig): Record<string, unknown> {
  if (config.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName: config.serverName,
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
      cwd: config.cwd,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      failOnStartupError: config.failOnStartupError,
    };
  }
  return {
    transport: 'streamable-http',
    serverName: config.serverName,
    url: config.url,
    headers: config.headers ?? {},
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
  };
}
