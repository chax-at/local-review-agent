// src/main-forgejo.ts
import 'dotenv/config';
// The config reads the .env above. The instrumentation must start before the other imports: the metrics API has no
// proxy, so a meter that an import creates before the start stays a no-op.
import { configureInstrumentation } from './instrumentation/instrumentation';

configureInstrumentation();

import LogSink from '@chax-at/log-sink';
import config from './safe-config';
import { configureLogSink } from './log/logsink.init';
import { TraceTags } from './log/tags';
import { ForgejoProvider } from './provider/forgejo/forgejo.client';
import { buildAndStart, requireNonEmpty } from './bootstrap';

void (async () => {
  await configureLogSink();
  LogSink.info('local-git-reviewer (forgejo) starting...', TraceTags.DEBUG);

  const baseUrl = requireNonEmpty(config.get('Forgejo.BaseUrl'), 'FORGEJO_BASE_URL');
  const token = requireNonEmpty(config.get('Forgejo.Token'), 'FORGEJO_TOKEN');
  const botUsername = requireNonEmpty(config.get('Forgejo.BotUsername'), 'FORGEJO_BOT_USERNAME');

  LogSink.debug(`Forgejo: ${baseUrl}`, TraceTags.DEBUG);

  const provider = new ForgejoProvider(baseUrl, token);
  await buildAndStart({
    provider,
    botUsername,
    gitConfig: provider.getGitConfig(),
  });
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
