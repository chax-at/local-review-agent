import * as fs from 'fs';
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

describe('tools/pi-runner.Dockerfile', () => {
  const dockerfile = fs.readFileSync(new URL('../../tools/pi-runner.Dockerfile', import.meta.url), 'utf-8');
  const stages = dockerfile.split(/^FROM /m).slice(1);

  it('has an installer stage and a base stage', () => {
    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatch(/^\$\{NODE_IMAGE\} AS pi/);
    expect(stages[1]).toMatch(/^\$\{BASE_IMAGE\}/);
  });

  // A per-repo base image (php:8.3-cli, python:3.12, ...) ships no npm, so an
  // npm command in the base stage fails the build with `npm: not found`.
  it('never runs npm in the base-image stage', () => {
    expect(stages[1]).not.toMatch(/\bnpm\b/);
  });

  it('copies the self-contained pi prefix into the base image and puts it on PATH', () => {
    expect(stages[0]).toMatch(/npm install -g --prefix \/opt\/pi @mariozechner\/pi-coding-agent@\$\{PI_AGENT_VERSION\}/);
    expect(stages[0]).toMatch(/cp \/usr\/local\/bin\/node \/opt\/pi\/bin\/node/);
    expect(stages[1]).toMatch(/COPY --from=pi \/opt\/pi \/opt\/pi/);
    expect(stages[1]).toMatch(/ENV PATH=\/opt\/pi\/bin:\$PATH/);
  });
});
