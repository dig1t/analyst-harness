export const TASK_TYPES = [
  'scrape',
  'analysis',
  'report',
  'dashboard',
  'research',
  'knowledge',
  'maintenance',
  'general',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

type Rule = { type: TaskType; patterns: Array<[RegExp, number]> };

/**
 * Weighted intent patterns. Verbs that state the goal ("fix", "report", "scrape") weigh more
 * than nouns that merely appear in the task ("dataset", "selectors"). Earlier rules win ties,
 * so repairing a scraper counts as maintenance rather than scraping.
 */
const RULES: Rule[] = [
  {
    type: 'maintenance',
    patterns: [
      [/\b(fix|repair|broken|broke|failing|fails|debug)\b/i, 3],
      [/\bupdate\b.*\bscraper\b/i, 2],
      [/\bmigrat/i, 1],
      [/\b(changed|stopped working)\b/i, 1],
    ],
  },
  {
    type: 'knowledge',
    patterns: [
      [/\bwiki\b/i, 3],
      [/\bknowledge (base|vault)\b/i, 3],
      [/\bvault\b/i, 2],
      [/\bingest\b/i, 2],
      [/\bobsidian\b/i, 2],
      [/\blessons?\b/i, 1],
    ],
  },
  {
    type: 'scrape',
    patterns: [
      [/\bscrap(e|er|ers|ing)\b/i, 2],
      [/\bcrawl/i, 2],
      [/\bspider\b/i, 1],
      [/\bcollect\b.*\b(data|pages|listings)\b/i, 1],
      [/\bextract\b.*\bfrom\b.*\b(site|page|url|website)\b/i, 2],
      [/\bselectors?\b/i, 1],
      [/\bsitemap\b/i, 1],
      [/\brss\b|\bfeed\b/i, 1],
      [/\bevery (day|hour|week|morning)\b|\bdaily\b|\bhourly\b/i, 1],
    ],
  },
  {
    type: 'dashboard',
    patterns: [
      [/\bdashboards?\b/i, 4],
      [/\b(charts?|plots?|graphs?|visuali[sz]\w*)\b/i, 2],
      [/\bexplor(e|er)\b.*\b(data|dataset)\b/i, 2],
      [/\b(kpis?|heatmap|histogram|scatter)\b/i, 1],
    ],
  },
  {
    type: 'report',
    patterns: [
      [/\breport\b/i, 3],
      [/\bsummar(y|ise|ize)\b/i, 2],
      [/\bdigest\b/i, 2],
      [/\bwrite[- ]?up\b/i, 2],
    ],
  },
  {
    type: 'analysis',
    patterns: [
      [/\banaly[sz]/i, 2],
      [/\bsql\b|\bquery\b/i, 2],
      [
        /\b(average|median|mean|trend|correlat\w*|distribution|regression|growth|percent\w*|aggregate|group by|pivot)\b/i,
        2,
      ],
      [/\bhow many\b/i, 2],
      [/\bcompare\b/i, 1],
      [/\bdataset\b|\bcsv\b|\bparquet\b|\bjsonl?\b/i, 1],
    ],
  },
  {
    type: 'research',
    patterns: [
      [/\bresearch\b/i, 2],
      [/\bfind out\b/i, 1],
      [/\blook up\b/i, 1],
      [/\bwhat is\b|\bwho is\b/i, 1],
      [/\bsources?\b/i, 1],
      [/\bweb\b/i, 1],
    ],
  },
];

/**
 * Cheap keyword classifier for the bandit context. No LLM call: the label only has to be
 * stable, because the bandit learns per (model, task type) which harness profile works.
 */
export function classifyTask(text: string): TaskType {
  let best: TaskType = 'general';
  let bestScore = 0;
  for (const rule of RULES) {
    const score = rule.patterns.reduce((n, [re, weight]) => n + (re.test(text) ? weight : 0), 0);
    if (score > bestScore) {
      best = rule.type;
      bestScore = score;
    }
  }
  return best;
}
