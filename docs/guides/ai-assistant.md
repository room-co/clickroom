# AI assistant (Ask AI)

**Ask AI** is a chat in the dashboard that answers questions about your project's data, and can
help create flags, experiments, segments and insights. Clickroom does not include a language model.
You connect your own provider account, so the questions and the data needed to answer them go to
that provider under your own agreement with them.

## Connect a provider

You need the **Admin** role.

1. Sidebar **Settings**, tab **AI Assistant**.
2. **Provider.** Choose Anthropic, OpenAI or Google.
3. **Model.** The field is pre-filled with a default for the provider; change it if you prefer
   another model your key can use.
4. **API key.** Paste the key from your provider's console.
5. Save.

The key is stored encrypted on your server and is never shown again. It is encrypted with the
`AI_ENCRYPTION_KEY` value of your install, so keep that secret stable (see
[configuration](../self-host/configuration.md#ai-features)). Until a key is saved, the Ask AI page
shows "Connect an AI provider to use Ask AI".

Besides the main model, Ask AI makes small calls to a cheaper model from the same provider to check
that a question is on topic. These use the same key.

## Ask a question

1. Sidebar **Ask AI**.
2. Start a new chat and type a question, for example:
   - "How many users signed up in the last 7 days, by day?"
   - "Which pages have the highest bounce rate?"
   - "Create a flag called new-pricing at 10 percent rollout."
   - "Run SQL to find the top 5 events by unique users this month."
3. The assistant calls Clickroom's tools to look up data, shows what it did and answers.

Past chats are listed in the conversation panel (**Toggle conversations** on small screens).

When the assistant wants to change something, such as creating a flag, it asks you to confirm
first. Nothing is changed until you approve.

## Tips and limits

- The assistant works inside the project selected in the sidebar.
- It only answers questions about analytics, flags, experiments, segments and your data. Unrelated
  questions are declined.
- It can make mistakes. Check numbers that matter against the dashboard or the
  [SQL Explorer](sql-explorer.md).
- If you see "Ask AI is temporarily disabled", the feature is switched off for your install.
