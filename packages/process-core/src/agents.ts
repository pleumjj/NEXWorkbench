import type { ProcessInfo } from '@nex/shared';

/**
 * AI coding agents recognised by their executable (or the script a runtime runs). Deterministic: names and
 * package paths only — never prompts, transcripts or file contents.
 */
export type AgentToolId = 'claude-code' | 'codex' | 'gemini' | 'aider' | 'cursor-agent' | 'opencode' | 'goose' | 'copilot';

export const AGENT_TOOLS: { id: AgentToolId; name: string; bins: string[]; packages: RegExp }[] = [
  { id: 'claude-code', name: 'Claude Code', bins: ['claude'], packages: /@anthropic-ai[\\/]claude-code/ },
  { id: 'codex', name: 'Codex', bins: ['codex'], packages: /@openai[\\/]codex/ },
  { id: 'gemini', name: 'Gemini CLI', bins: ['gemini'], packages: /@google[\\/]gemini-cli/ },
  { id: 'aider', name: 'Aider', bins: ['aider'], packages: /[\\/]aider[\\/]/ },
  { id: 'cursor-agent', name: 'Cursor Agent', bins: ['cursor-agent'], packages: /cursor-agent/ },
  { id: 'opencode', name: 'OpenCode', bins: ['opencode'], packages: /[\\/]opencode-ai[\\/]/ },
  { id: 'goose', name: 'Goose', bins: ['goose'], packages: /[\\/]goose-cli[\\/]/ },
  { id: 'copilot', name: 'Copilot CLI', bins: ['copilot'], packages: /@github[\\/]copilot/ },
];
const BY_BIN = new Map(AGENT_TOOLS.flatMap(t => t.bins.map(b => [b, t.id] as const)));
const RUNTIMES = /^(node|bun|deno|python[\d.]*|Python)(\.exe)?$/;
const base = (s: string) => s.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|js|mjs|cjs)$/i, '');

/** The agent a process *is* (not one it was started by): `claude`, `node …/bin/claude`, `python …/aider`. */
export function detectAgent(p: Pick<ProcessInfo, 'name' | 'command'>): AgentToolId | null {
  const name = base(p.name);
  const direct = BY_BIN.get(name);
  // The Claude desktop app's main process is "Claude" (capitalised) — an app, not an agent session.
  if (direct) return direct;
  if (RUNTIMES.test(p.name)) {
    const script = p.command.trim().split(/\s+/)[1] ?? '';
    const tool = BY_BIN.get(base(script));
    if (tool) return tool;
    const pkg = AGENT_TOOLS.find(t => t.packages.test(script));
    if (pkg) return pkg.id;
  }
  return null;
}

export const agentName = (id: AgentToolId) => AGENT_TOOLS.find(t => t.id === id)?.name ?? id;

/** Secrets in command lines (`--api-key=…`, `TOKEN=…`) are masked before they are shown anywhere. */
export function maskCommand(command: string, max = 240): string {
  const masked = command
    .replace(/(--?[\w-]*(?:key|token|secret|password|passwd|auth)[\w-]*[= ])\S+/gi, '$1***')
    .replace(/\b([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*=)\S+/g, '$1***')
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s]+@/g, '$1***@');
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}
