// Grouped fill-in-the-blank starter prompts (PostHog-Max-inspired UX) shared by `AskAIEmptyState` (full grid) and
// `SuggestionChips` (compact inline strip once a conversation has messages).
export interface StarterPrompt {
  label: string
  prompt: string
}

export interface StarterGroup {
  domain: string
  prompts: StarterPrompt[]
}

export const STARTER_GROUPS: StarterGroup[] = [
  {
    domain: 'Analytics',
    prompts: [
      {
        label: 'How did pageviews trend over the last 14 days?',
        prompt: 'How did pageviews trend over the last 14 days?',
      },
      { label: 'What are the top events this week?', prompt: 'What are the top events this week?' },
    ],
  },
  {
    domain: 'Flags',
    prompts: [
      { label: 'List all active feature flags', prompt: 'List all active feature flags' },
      {
        label: 'What is the rollout % for [flag key]?',
        prompt: 'What is the rollout percentage for the flag ',
      },
    ],
  },
  {
    domain: 'Experiments',
    prompts: [
      {
        label: 'Summarize results for [experiment]',
        prompt: 'Summarize the results for the experiment ',
      },
      {
        label: 'Which running experiments need attention?',
        prompt: 'Which running experiments need attention?',
      },
    ],
  },
  {
    domain: 'SQL',
    prompts: [
      { label: 'Run a SQL query for [question]', prompt: 'Run a SQL query to answer: ' },
      {
        label: 'How many distinct users did we see today?',
        prompt: 'How many distinct users did we see today?',
      },
    ],
  },
]

export function getAllStarterPrompts(): StarterPrompt[] {
  return STARTER_GROUPS.flatMap((g) => g.prompts)
}
