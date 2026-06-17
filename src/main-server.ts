// src/main.ts (renamed to main-server.ts in Task 15)
import 'dotenv/config';
import LogSink from '@chax-at/log-sink';
import config from './safe-config';
import { configureLogSink } from './log/logsink.init';
import { TraceTags } from './log/tags';
import { BitbucketServerProvider } from './provider/bitbucket-server/server.client';
import { buildAndStart, requireNonEmpty } from './bootstrap';

void (async () => {
  await configureLogSink();
  LogSink.info('local-git-reviewer (bitbucket-server) starting...', TraceTags.DEBUG);

  const baseUrl = requireNonEmpty(config.get('Bitbucket.BaseUrl'), 'BITBUCKET_BASE_URL');
  const pat = requireNonEmpty(config.get('Bitbucket.Pat'), 'BITBUCKET_PAT');
  const botUsername = config.get('Bitbucket.BotUsername');

  LogSink.debug(`Bitbucket Server: ${baseUrl}`, TraceTags.DEBUG);

  const provider = new BitbucketServerProvider(baseUrl, pat);
  await buildAndStart({
    provider,
    botUsername,
    gitConfig: provider.getGitConfig(),
  });
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
