import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Message,
  type SendableChannels,
} from 'discord.js';
import type { Logger } from '../util/logger';
import { isAdmin, isAuthorized, type AuthPolicy, type DiscordUser } from './auth';
import { DiscordApprovalGateway, type ButtonPrompt } from './approvals';
import { toDiscordJson } from './commands';
import type { CommandReply } from './format';
import { LEVEL_COLORS, type Notification, type Notifier } from './notifier';
import {
  CommandRouter,
  parsePrefixCommand,
  type HarnessOps,
  type Invocation,
  type Responder,
} from './router';

export interface DiscordBotOptions {
  token: string;
  applicationId: string;
  guildId?: string;
  channels: { reports?: string; alerts?: string };
  auth: AuthPolicy;
  prefixCommands: boolean;
  approvalTimeoutMs: number;
  logger: Logger;
}

function feedbackRow(runId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`feedback:up:${runId}`)
      .setLabel('Good answer')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`feedback:down:${runId}`)
      .setLabel('Bad answer')
      .setStyle(ButtonStyle.Danger),
  );
}

function payload(reply: CommandReply) {
  return {
    content: reply.content.slice(0, 2000),
    files: reply.file
      ? [new AttachmentBuilder(Buffer.from(reply.file.content, 'utf8'), { name: reply.file.name })]
      : [],
    components: reply.feedbackRunId ? [feedbackRow(reply.feedbackRunId)] : [],
    allowedMentions: { parse: [] as never[] },
  };
}

function rolesOf(member: unknown): string[] {
  const roles = (member as { roles?: unknown } | null)?.roles;
  if (Array.isArray(roles)) return roles.map(String);
  const cache = (roles as { cache?: Map<string, unknown> } | undefined)?.cache;
  return cache ? [...cache.keys()] : [];
}

class ChannelButtonPrompt implements ButtonPrompt {
  constructor(private readonly channel: SendableChannels) {}

  async ask(
    text: string,
    opts: { timeoutMs: number; canAnswer: (userId: string) => boolean },
  ): Promise<boolean | undefined> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('approval:yes').setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('approval:no').setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    const msg = await this.channel.send({
      content: text.slice(0, 2000),
      components: [row],
      allowedMentions: { parse: [] },
    });
    try {
      const click = await msg.awaitMessageComponent({
        filter: (i) => opts.canAnswer(i.user.id),
        time: opts.timeoutMs,
      });
      const approved = click.customId === 'approval:yes';
      await click.update({
        content: `${text.slice(0, 1800)}\n\n${approved ? 'Approved' : 'Denied'} by <@${click.user.id}>`,
        components: [],
      });
      return approved;
    } catch {
      await msg
        .edit({ content: `${text.slice(0, 1800)}\n\nNo answer in time: denied.`, components: [] })
        .catch(() => undefined);
      return undefined;
    }
  }
}

/** discord.js adapter: slash commands, buttons, prefix messages and channel notifications. */
export class DiscordBot implements Notifier {
  readonly client: Client;
  private readonly router: CommandRouter;

  constructor(
    private readonly ops: HarnessOps,
    private readonly opts: DiscordBotOptions,
  ) {
    const intents = [GatewayIntentBits.Guilds];
    if (opts.prefixCommands) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    this.client = new Client({ intents });
    this.router = new CommandRouter(ops, opts.auth, {
      approvalsFor: (inv) => {
        const channel = inv.channelId ? this.client.channels.cache.get(inv.channelId) : undefined;
        if (!channel || !channel.isSendable()) return undefined;
        return new DiscordApprovalGateway(
          new ChannelButtonPrompt(channel),
          // Only the person who asked, or an admin, may approve what their run does.
          (id) => id === inv.user.id || isAdmin({ id, roles: [] }, opts.auth),
          opts.approvalTimeoutMs,
        );
      },
    });
  }

  async registerCommands(): Promise<void> {
    const rest = new REST().setToken(this.opts.token);
    const route = this.opts.guildId
      ? Routes.applicationGuildCommands(this.opts.applicationId, this.opts.guildId)
      : Routes.applicationCommands(this.opts.applicationId);
    await rest.put(route, { body: toDiscordJson() });
    this.opts.logger.info('registered slash commands', { scope: this.opts.guildId ? 'guild' : 'global' });
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, (c) =>
      this.opts.logger.info('discord bot ready', { user: c.user.tag }),
    );
    this.client.on(Events.InteractionCreate, async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) await this.onCommand(interaction);
        else if (interaction.isButton() && interaction.customId.startsWith('feedback:')) {
          const [, value, runId] = interaction.customId.split(':');
          const user: DiscordUser = {
            id: interaction.user.id,
            name: interaction.user.username,
            roles: rolesOf(interaction.member),
          };
          if (!isAuthorized(user, this.opts.auth)) {
            await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
            return;
          }
          const ok = await this.ops.feedback(
            runId ?? '',
            value === 'down' ? 'down' : 'up',
            user.name ?? user.id,
          );
          await interaction.reply({
            content: ok ? 'Thanks, feedback recorded.' : 'Run not found.',
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (err) {
        this.opts.logger.error('interaction failed', { err });
      }
    });
    if (this.opts.prefixCommands) {
      this.client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        const parsed = parsePrefixCommand(message.content);
        if (!parsed) return;
        const inv: Invocation = {
          ...parsed,
          user: { id: message.author.id, name: message.author.username, roles: rolesOf(message.member) },
          channelId: message.channelId,
        };
        await this.router.dispatch(inv, this.messageResponder(message));
      });
    }
    await this.client.login(this.opts.token);
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const options: Invocation['options'] = {};
    for (const opt of interaction.options.data.flatMap((d) => (d.options ? d.options : [d]))) {
      if (opt.value !== undefined && opt.value !== null)
        options[opt.name] = opt.value as string | number | boolean;
    }
    const inv: Invocation = {
      command: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false) ?? undefined,
      options,
      user: { id: interaction.user.id, name: interaction.user.username, roles: rolesOf(interaction.member) },
      channelId: interaction.channelId,
    };
    await this.router.dispatch(inv, this.interactionResponder(interaction));
  }

  private interactionResponder(interaction: ChatInputCommandInteraction): Responder {
    const fallback = async (reply: CommandReply) => {
      // Interaction tokens expire after 15 minutes; long runs post a new message instead.
      const channel = interaction.channel;
      if (channel && channel.isSendable()) await channel.send(payload(reply));
    };
    return {
      defer: async (ephemeral) => {
        if (!interaction.deferred && !interaction.replied)
          await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      },
      progress: async (text) => {
        if (interaction.deferred)
          await interaction.editReply({ content: text.slice(0, 2000) }).catch(() => undefined);
      },
      finish: async (reply) => {
        try {
          if (interaction.deferred || interaction.replied) await interaction.editReply(payload(reply));
          else
            await interaction.reply({
              ...payload(reply),
              ...(reply.ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}),
            });
        } catch {
          await fallback(reply);
        }
      },
    };
  }

  private messageResponder(message: Message): Responder {
    let status: Message | undefined;
    return {
      defer: async () => {
        status = await message.reply({ content: 'Working...', allowedMentions: { parse: [] } });
      },
      progress: async (text) => {
        await status?.edit({ content: text.slice(0, 2000) }).catch(() => undefined);
      },
      finish: async (reply) => {
        if (status) await status.edit(payload(reply));
        else await message.reply(payload(reply));
      },
    };
  }

  async notify(n: Notification): Promise<void> {
    const id =
      n.channel === 'alerts'
        ? (this.opts.channels.alerts ?? this.opts.channels.reports)
        : this.opts.channels.reports;
    if (!id || !this.client.isReady()) return;
    const channel = await this.client.channels.fetch(id).catch(() => null);
    if (!channel || !channel.isSendable()) return;
    await channel.send({
      embeds: [
        {
          title: n.title.slice(0, 256),
          description: n.body.slice(0, 4000),
          color: LEVEL_COLORS[n.level ?? 'info'],
        },
      ],
      files: n.file
        ? [new AttachmentBuilder(Buffer.from(n.file.content, 'utf8'), { name: n.file.name })]
        : [],
      allowedMentions: { parse: [] },
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }
}
