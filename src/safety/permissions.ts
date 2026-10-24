import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';

export type Decision = 'allow' | 'ask' | 'deny';

export type PermissionKind = 'bash' | 'write' | 'read_sensitive' | 'network' | 'tool';

export interface PermissionRequest {
  kind: PermissionKind;
  tool: string;
  /** One-line human readable description shown to approvers. */
  summary: string;
  command?: string;
  path?: string;
  url?: string;
  detail?: string;
}

export interface ApprovalContext {
  runId: string;
  agent: string;
}

/** Something that can ask a human (Discord buttons, a terminal prompt) and wait for an answer. */
export interface ApprovalGateway {
  request(req: PermissionRequest, ctx: ApprovalContext): Promise<boolean>;
}

export type PermissionMode = 'default' | 'trusted' | 'readonly';

export interface PermissionPolicy {
  /**
   * default: allow-listed commands run, deny-listed are refused, everything else asks a human.
   * trusted: everything except the deny list runs (for unattended jobs inside a sandbox).
   * readonly: only allow-listed read-only commands run; every write is refused.
   */
  mode: PermissionMode;
  bashAllow: string[];
  bashDeny: string[];
  /** Decision for "ask" when no approval gateway is attached (cron, CI). */
  askFallback: 'allow' | 'deny';
  writeRequiresApproval: boolean;
}

/** Destructive commands the permission layer rejects by default (paper, Figure 27). */
export const DEFAULT_BASH_DENY = [
  String.raw`\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\b`,
  String.raw`(^|[\s;&|(])sudo\b`,
  String.raw`\bgit\s+push\b`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bgit\s+clean\s+-[a-zA-Z]*f`,
  String.raw`\bchmod\s+-R\b`,
  String.raw`\bchown\s+-R\b`,
  String.raw`\bmkfs(\.\w+)?\b`,
  String.raw`\bdd\s+if=`,
  String.raw`\b(shutdown|reboot|halt|poweroff)\b`,
  String.raw`:\(\)\s*\{`,
  String.raw`\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b`,
  String.raw`>\s*/dev/sd`,
  String.raw`\bsystemctl\b`,
  String.raw`\bcrontab\s+-r\b`,
];

/** Read-only commands that run without prompting (paper, Figure 27, plus a few analysis tools). */
export const DEFAULT_BASH_ALLOW = [
  String.raw`^git\s+(status|diff|log|branch|show)\b`,
  String.raw`^(ls|pwd|rg|cat|head|tail|wc|file|stat|du|df|which|date|echo|printf|sort|uniq|cut|tr|basename|dirname|realpath)\b`,
  String.raw`^grep\b`,
  String.raw`^jq\b`,
  String.raw`^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b)`,
];

export const DEFAULT_POLICY: PermissionPolicy = {
  mode: 'default',
  bashAllow: DEFAULT_BASH_ALLOW,
  bashDeny: DEFAULT_BASH_DENY,
  askFallback: 'deny',
  writeRequiresApproval: false,
};

/** Split a shell command into simple-command segments on ; && || | and newlines. */
export function splitCommand(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/** True when the command writes through redirection or runs nested commands. */
export function hasSideChannels(command: string): boolean {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  if (/\$\(|`/.test(unquoted)) return true;
  // Output redirection to anything other than /dev/null or another stream.
  return (
    /(^|[^0-9&<>])>{1,2}\s*(?!\s*(\/dev\/null|&\d))/.test(unquoted) ||
    /\b\d>{1,2}\s*(?!\s*(\/dev\/null|&\d))/.test(unquoted)
  );
}

export class PermissionManager {
  private readonly allow: RegExp[];
  private readonly deny: RegExp[];
  private readonly approvals: Array<{ req: PermissionRequest; decision: Decision; allowed: boolean }> = [];

  constructor(
    readonly policy: PermissionPolicy = DEFAULT_POLICY,
    private gateway?: ApprovalGateway,
    private readonly logger: Logger = silentLogger,
  ) {
    this.allow = policy.bashAllow.map((p) => new RegExp(p));
    this.deny = policy.bashDeny.map((p) => new RegExp(p));
  }

  setGateway(gateway: ApprovalGateway | undefined): void {
    this.gateway = gateway;
  }

  get history() {
    return this.approvals;
  }

  classifyBash(command: string): Decision {
    const segments = splitCommand(command);
    if (
      segments.some((seg) => this.deny.some((re) => re.test(seg))) ||
      this.deny.some((re) => re.test(command))
    ) {
      return 'deny';
    }
    const allowListed =
      segments.length > 0 &&
      !hasSideChannels(command) &&
      segments.every((seg) => this.allow.some((re) => re.test(seg)));
    if (allowListed) return 'allow';
    switch (this.policy.mode) {
      case 'trusted':
        return 'allow';
      case 'readonly':
        return 'deny';
      default:
        return 'ask';
    }
  }

  classify(req: PermissionRequest): Decision {
    switch (req.kind) {
      case 'bash':
        return this.classifyBash(req.command ?? '');
      case 'write':
        if (this.policy.mode === 'readonly') return 'deny';
        return this.policy.writeRequiresApproval && this.policy.mode !== 'trusted' ? 'ask' : 'allow';
      case 'read_sensitive':
        return this.policy.mode === 'trusted' ? 'allow' : 'ask';
      case 'network':
      case 'tool':
        return 'allow';
    }
  }

  /** Decide, asking a human through the gateway when the policy says "ask". */
  async check(
    req: PermissionRequest,
    ctx: ApprovalContext,
  ): Promise<{ allowed: boolean; decision: Decision }> {
    const decision = this.classify(req);
    let allowed = decision === 'allow';
    if (decision === 'ask') {
      if (this.gateway) {
        try {
          allowed = await this.gateway.request(req, ctx);
        } catch (err) {
          this.logger.warn('approval gateway failed; denying', { err, tool: req.tool });
          allowed = false;
        }
      } else {
        allowed = this.policy.askFallback === 'allow';
      }
    }
    this.approvals.push({ req, decision, allowed });
    this.logger.debug('permission', { tool: req.tool, kind: req.kind, decision, allowed });
    return { allowed, decision };
  }
}
