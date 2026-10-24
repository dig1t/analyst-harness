export interface CommandOptionSpec {
  name: string;
  description: string;
  type: 'string' | 'integer' | 'boolean';
  required?: boolean;
  choices?: Array<{ name: string; value: string }>;
}

export interface SubcommandSpec {
  name: string;
  description: string;
  options?: CommandOptionSpec[];
  admin?: boolean;
}

export interface CommandSpec {
  name: string;
  description: string;
  options?: CommandOptionSpec[];
  subcommands?: SubcommandSpec[];
  admin?: boolean;
}

const name = (description: string, required = true): CommandOptionSpec => ({
  name: 'name',
  description,
  type: 'string',
  required,
});

export const COMMANDS: CommandSpec[] = [
  {
    name: 'ask',
    description: 'Give the analyst agent a data task',
    options: [
      { name: 'task', description: 'What to analyze, scrape or report', type: 'string', required: true },
      { name: 'agent', description: 'Agent to use (default: analyst)', type: 'string' },
      {
        name: 'profile',
        description: 'Harness profile id such as t4-plan-tools-128k, or auto',
        type: 'string',
      },
    ],
  },
  {
    name: 'scrape',
    description: 'Manage scrapers',
    subcommands: [
      { name: 'list', description: 'List registered scrapers and their schedules' },
      {
        name: 'run',
        description: 'Run a scraper now',
        options: [
          name('Scraper name'),
          { name: 'dry_run', description: 'Do not write to the dataset', type: 'boolean' },
        ],
      },
      {
        name: 'status',
        description: 'Health and recent history of a scraper',
        options: [name('Scraper name')],
      },
      {
        name: 'repair',
        description: 'Ask the scraper-engineer agent to diagnose a broken scraper',
        options: [name('Scraper name')],
      },
      {
        name: 'apply',
        description: 'Apply a repaired spec from proposals/scrapers/<name>.yaml',
        options: [name('Scraper name')],
        admin: true,
      },
    ],
  },
  { name: 'jobs', description: 'Scheduled jobs and their next runs' },
  {
    name: 'runs',
    description: 'Recent agent runs',
    options: [{ name: 'limit', description: 'How many (default 10)', type: 'integer' }],
  },
  {
    name: 'run',
    description: 'Details of one run',
    options: [{ name: 'id', description: 'Run id', type: 'string', required: true }],
  },
  {
    name: 'stop',
    description: 'Stop a running agent run',
    options: [{ name: 'id', description: 'Run id', type: 'string', required: true }],
  },
  {
    name: 'feedback',
    description: 'Rate a run (teaches the profile bandit)',
    options: [
      { name: 'id', description: 'Run id', type: 'string', required: true },
      {
        name: 'value',
        description: 'Was the answer good?',
        type: 'string',
        required: true,
        choices: [
          { name: 'good', value: 'up' },
          { name: 'bad', value: 'down' },
        ],
      },
    ],
  },
  { name: 'budget', description: "Today's LLM spend against the daily cap" },
  {
    name: 'skills',
    description: 'Skills library',
    subcommands: [
      { name: 'list', description: 'List active skills' },
      { name: 'proposed', description: 'Skills drafted by the learning loop, awaiting approval' },
      {
        name: 'approve',
        description: 'Approve a proposed skill',
        options: [name('Skill name')],
        admin: true,
      },
      { name: 'reject', description: 'Reject a proposed skill', options: [name('Skill name')], admin: true },
    ],
  },
  {
    name: 'knowledge',
    description: 'Search the knowledge vault',
    options: [
      { name: 'query', description: 'Search terms', type: 'string', required: true },
      { name: 'topic', description: 'Restrict to one topic folder', type: 'string' },
    ],
  },
  {
    name: 'lessons',
    description: 'Search lessons learned from past runs',
    options: [{ name: 'query', description: 'Search terms', type: 'string' }],
  },
  { name: 'learn', description: 'Run the learning loop on unprocessed runs now', admin: true },
  {
    name: 'profiles',
    description: 'What the profile bandit has learned',
    options: [{ name: 'task_type', description: 'Filter by task type', type: 'string' }],
  },
  { name: 'status', description: 'Harness health' },
  { name: 'help', description: 'List commands' },
];

const OPTION_TYPES = { string: 3, integer: 4, boolean: 5 } as const;
const SUB_COMMAND = 1;

function optionJson(o: CommandOptionSpec) {
  return {
    type: OPTION_TYPES[o.type],
    name: o.name,
    description: o.description.slice(0, 100),
    required: o.required ?? false,
    ...(o.choices ? { choices: o.choices } : {}),
  };
}

/** Application command JSON for the Discord REST API (PUT /applications/{id}/commands). */
export function toDiscordJson(specs: CommandSpec[] = COMMANDS): Array<Record<string, unknown>> {
  return specs.map((c) => ({
    name: c.name,
    description: c.description.slice(0, 100),
    options: c.subcommands
      ? c.subcommands.map((s) => ({
          type: SUB_COMMAND,
          name: s.name,
          description: s.description.slice(0, 100),
          options: (s.options ?? []).map(optionJson),
        }))
      : (c.options ?? []).map(optionJson),
  }));
}

export function isAdminCommand(command: string, subcommand?: string): boolean {
  const spec = COMMANDS.find((c) => c.name === command);
  if (!spec) return false;
  if (spec.admin) return true;
  return spec.subcommands?.find((s) => s.name === subcommand)?.admin === true;
}

export function helpText(): string {
  const lines = ['**analyst-harness commands**'];
  for (const c of COMMANDS) {
    if (c.subcommands)
      for (const s of c.subcommands)
        lines.push(`\`/${c.name} ${s.name}\` ${s.description}${s.admin ? ' (admin)' : ''}`);
    else lines.push(`\`/${c.name}\` ${c.description}${c.admin ? ' (admin)' : ''}`);
  }
  return lines.join('\n');
}
