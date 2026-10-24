// Keep tests hermetic: never pick up real credentials or notify real channels.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.DISCORD_TOKEN;
delete process.env.DISCORD_WEBHOOK_URL;
process.env.TZ = 'UTC';
