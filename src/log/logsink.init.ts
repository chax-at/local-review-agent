import { SecureTCPTransport, TCPTransport } from '@chax-at/gelf-client';
import LogSink, { ConsoleLogDrain, GelfLogDrain } from '@chax-at/log-sink';
import config from '../safe-config';

export async function configureLogSink(): Promise<void> {
  const debugLogs = config.get('Diagnostics.DebugLogs');
  const consoleEnabled = config.get('Diagnostics.Logging.Console.Enabled');
  if (consoleEnabled) {
    const configuredMax = config.get('Diagnostics.Logging.Console.MaxLevel');
    // Debug is syslog level 7 — cap at 6 when debugLogs is off
    const maxLevel = debugLogs ? configuredMax : Math.min(configuredMax, 6);
    LogSink.registerDrain(
      new ConsoleLogDrain({
        useColor: config.get('Diagnostics.Logging.Console.Colors'),
        logAttributes: config.get('Diagnostics.Logging.Console.LogData'),
      }),
      {
        enabled: true,
        minLevel: config.get('Diagnostics.Logging.Console.MinLevel'),
        maxLevel,
      },
    );
  }

  const gelfEnabled = config.get('Diagnostics.Logging.Gelf.Enabled');
  if (gelfEnabled) {
    const host = config.get('Diagnostics.Logging.Gelf.Host');
    const port = config.get('Diagnostics.Logging.Gelf.Port');
    const useTls = config.get('Diagnostics.Logging.Gelf.TLS.UseTLS');

    let transport;
    if (useTls) {
      const ca = config.get('Diagnostics.Logging.Gelf.TLS.ServerCACert');
      const cert = config.get('Diagnostics.Logging.Gelf.TLS.ClientCert');
      const key = config.get('Diagnostics.Logging.Gelf.TLS.ClientKey');
      transport = new SecureTCPTransport({
        host,
        port,
        ca: ca !== '' ? ca : undefined,
        cert: cert !== '' ? cert : undefined,
        key: key !== '' ? key : undefined,
      });
    } else {
      transport = new TCPTransport({ host, port });
    }

    LogSink.registerDrain(new GelfLogDrain(transport), {
      enabled: true,
      minLevel: config.get('Diagnostics.Logging.Gelf.MinLevel'),
      maxLevel: config.get('Diagnostics.Logging.Gelf.MaxLevel'),
    });
  }
}
