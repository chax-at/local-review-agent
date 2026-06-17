import { describe, it, expect } from 'vitest';
import { buildPiRunnerImageArgs, derivedTagForBase } from '../../src/reviewer/pi-runner-image';

describe('buildPiRunnerImageArgs', () => {
  it('produces the expected docker build argv for a concrete version', () => {
    const args = buildPiRunnerImageArgs('0.1.7');
    expect(args).toEqual([
      'build',
      '-t', 'lgr-pi-runner:0.1.7',
      '-t', 'lgr-pi-runner:latest',
      '--build-arg', 'PI_AGENT_VERSION=0.1.7',
      '-f', 'tools/pi-runner.Dockerfile',
      'tools',
    ]);
  });

  it('embeds the version into both the version-tag and the build-arg', () => {
    const args = buildPiRunnerImageArgs('1.2.3-beta.4');
    expect(args).toContain('-t');
    expect(args).toContain('lgr-pi-runner:1.2.3-beta.4');
    expect(args).toContain('--build-arg');
    expect(args).toContain('PI_AGENT_VERSION=1.2.3-beta.4');
    expect(args).toContain('lgr-pi-runner:latest');
  });

  it('produces a derived-image build for a custom base image', () => {
    const args = buildPiRunnerImageArgs('0.1.7', {
      baseImage: 'registry.example.com/library/node:22',
      tag: 'lgr-pi-runner-derived:abc123-0.1.7',
    });
    expect(args).toEqual([
      'build',
      '-t', 'lgr-pi-runner-derived:abc123-0.1.7',
      '--build-arg', 'PI_AGENT_VERSION=0.1.7',
      '--build-arg', 'BASE_IMAGE=registry.example.com/library/node:22',
      '-f', 'tools/pi-runner.Dockerfile',
      'tools',
    ]);
  });
});

describe('derivedTagForBase', () => {
  it('produces a deterministic tag containing the pi version', () => {
    const tag1 = derivedTagForBase('registry.example.com/library/node:22', '0.1.7');
    const tag2 = derivedTagForBase('registry.example.com/library/node:22', '0.1.7');
    expect(tag1).toBe(tag2);
    expect(tag1).toMatch(/^lgr-pi-runner-derived:[a-f0-9]+-0\.1\.7$/);
  });

  it('produces different tags for different base images', () => {
    const a = derivedTagForBase('registry.example.com/library/node:22', '0.1.7');
    const b = derivedTagForBase('registry.example.com/library/node:20', '0.1.7');
    expect(a).not.toBe(b);
  });

  it('produces different tags for different pi versions', () => {
    const a = derivedTagForBase('node:lts-slim', '0.1.7');
    const b = derivedTagForBase('node:lts-slim', '0.1.8');
    expect(a).not.toBe(b);
  });
});
