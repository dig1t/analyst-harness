import type { ApprovalContext, ApprovalGateway, PermissionRequest } from '../safety/permissions';

/** Something that can post a yes/no prompt and resolve with the first authorized answer. */
export interface ButtonPrompt {
  ask(
    text: string,
    opts: { timeoutMs: number; canAnswer: (userId: string) => boolean },
  ): Promise<boolean | undefined>;
}

/**
 * Human-in-the-loop approvals for the permission layer's "ask" decisions: the bot posts an
 * Approve / Deny prompt in the channel where the task was requested. No answer before the
 * timeout counts as a denial, so an unattended prompt never blocks a run forever.
 */
export class DiscordApprovalGateway implements ApprovalGateway {
  constructor(
    private readonly prompt: ButtonPrompt,
    private readonly canAnswer: (userId: string) => boolean,
    private readonly timeoutMs = 5 * 60 * 1000,
  ) {}

  static describe(req: PermissionRequest, ctx: ApprovalContext): string {
    const detail = req.command
      ? `\n\`\`\`sh\n${req.command.slice(0, 1500)}\n\`\`\``
      : req.path
        ? ` (\`${req.path}\`)`
        : req.url
          ? ` (${req.url})`
          : '';
    return `**Approval needed** for run \`${ctx.runId}\` (agent ${ctx.agent}): ${req.summary}${detail}`;
  }

  async request(req: PermissionRequest, ctx: ApprovalContext): Promise<boolean> {
    const answer = await this.prompt.ask(DiscordApprovalGateway.describe(req, ctx), {
      timeoutMs: this.timeoutMs,
      canAnswer: this.canAnswer,
    });
    return answer === true;
  }
}

/** Approves nothing; for unattended jobs where "ask" must mean "no". */
export const denyAllGateway: ApprovalGateway = { request: async () => false };
