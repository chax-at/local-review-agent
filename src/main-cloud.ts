// src/main-cloud.ts
import 'dotenv/config';
import LogSink from '@chax-at/log-sink';
import config from './safe-config';
import { configureLogSink } from './log/logsink.init';
import { TraceTags } from './log/tags';
import { BitbucketCloudProvider } from './provider/bitbucket-cloud/cloud.client';
import { buildAndStart, requireNonEmpty } from './bootstrap';

void (async () => {
  await configureLogSink();
  LogSink.info('local-git-reviewer (bitbucket-cloud) starting...', TraceTags.DEBUG);

  const workspace = requireNonEmpty(config.get('BitbucketCloud.Workspace'), 'BITBUCKET_CLOUD_WORKSPACE');
  const accessToken = requireNonEmpty(config.get('BitbucketCloud.AccessToken'), 'BITBUCKET_CLOUD_ACCESS_TOKEN');
  const botUsername = requireNonEmpty(config.get('BitbucketCloud.BotUsername'), 'BITBUCKET_CLOUD_BOT_USERNAME');
  const email = config.get('BitbucketCloud.Email') || undefined;

  LogSink.debug(`Bitbucket Cloud workspace: ${workspace} (auth=${email ? 'basic' : 'bearer'})`, TraceTags.DEBUG);

  const provider = new BitbucketCloudProvider(workspace, accessToken, email);
  await buildAndStart({
    provider,
    botUsername,
    gitConfig: provider.getGitConfig(),
  });
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
