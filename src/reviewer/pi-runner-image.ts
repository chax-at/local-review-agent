import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as path from 'path';
import LogSink from '@chax-at/log-sink';
import { TraceTags } from '../log/tags';

const IMAGE_NAME = 'lgr-pi-runner';
const DERIVED_IMAGE_NAME = 'lgr-pi-runner-derived';
const DEFAULT_BASE_IMAGE = 'node:lts-slim';
const DOCKERFILE_PATH = path.join('tools', 'pi-runner.Dockerfile');
const DOCKERFILE_CONTEXT = 'tools';
const PI_PACKAGE = '@mariozechner/pi-coding-agent';

let cachedPiVersion: string | null = null;

export interface IBuildPiRunnerImageArgsOptions {
  /** Base image to derive from. Defaults to node:lts-slim (the standard runner). */
  baseImage?: string;
  /** Single tag to apply when building a derived image. Required when baseImage is set. */
  tag?: string;
}

/**
 * Build the docker-build argv (excluding the `docker` binary itself) for the
 * pi-runner image at a given resolved pi version.
 *
 * Without options: builds the default `lgr-pi-runner:<version>` (and `:latest`)
 * image FROM node:lts-slim.
 *
 * With `{ baseImage, tag }`: builds a derived image from the given base, tagged
 * with the provided tag and a `BASE_IMAGE` build-arg passed to the Dockerfile.
 *
 * Pure function — exported separately so it can be unit-tested without
 * spawning Docker.
 */
export function buildPiRunnerImageArgs(version: string, options?: IBuildPiRunnerImageArgsOptions): string[] {
  if (options?.baseImage && options.tag) {
    return [
      'build',
      '-t',
      options.tag,
      '--build-arg',
      `PI_AGENT_VERSION=${version}`,
      '--build-arg',
      `BASE_IMAGE=${options.baseImage}`,
      '-f',
      DOCKERFILE_PATH,
      DOCKERFILE_CONTEXT,
    ];
  }
  return [
    'build',
    '-t',
    `${IMAGE_NAME}:${version}`,
    '-t',
    `${IMAGE_NAME}:latest`,
    '--build-arg',
    `PI_AGENT_VERSION=${version}`,
    '-f',
    DOCKERFILE_PATH,
    DOCKERFILE_CONTEXT,
  ];
}

/**
 * Deterministic local tag for a derived runner image: hash(base) + pi version.
 * The version suffix invalidates the cache when pi releases a new version.
 *
 * Pure — does not touch Docker.
 */
export function derivedTagForBase(baseImage: string, piVersion: string): string {
  const hash = createHash('sha256').update(baseImage).digest('hex').slice(0, 12);
  return `${DERIVED_IMAGE_NAME}:${hash}-${piVersion}`;
}

function resolvePiVersion(): string {
  if (cachedPiVersion) return cachedPiVersion;
  let version: string;
  try {
    const out = execFileSync('npm', ['view', PI_PACKAGE, 'version'], { encoding: 'utf-8' });
    version = out.trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`Unexpected version output from npm: ${JSON.stringify(out)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to resolve ${PI_PACKAGE} version via 'npm view'.\n` +
        `Run manually:\n  npm view ${PI_PACKAGE} version\n` +
        `Error: ${msg}`,
    );
  }
  cachedPiVersion = version;
  return version;
}

function imageExists(tag: string): boolean {
  let out: string;
  try {
    out = execFileSync('docker', ['images', '-q', tag], { encoding: 'utf-8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query Docker images. Is Docker installed and running?\n` + `Error: ${msg}`);
  }
  return out.trim().length > 0;
}

/**
 * Resolve the latest `@mariozechner/pi-coding-agent` version via npm and
 * ensure a `lgr-pi-runner:<version>` (and `:latest`) Docker image is built.
 *
 * Reuses the existing image when the resolved version matches a previously-
 * built tag. Throws (causing the caller to fail-fast) when:
 *  - npm cannot be reached or returns a malformed version,
 *  - docker is not available or `docker images` fails,
 *  - the docker build fails.
 *
 * Synchronous: the bot must not start the poller until the image is ready.
 */
export function ensurePiRunnerImage(): void {
  const version = resolvePiVersion();

  const versionedTag = `${IMAGE_NAME}:${version}`;
  const latestTag = `${IMAGE_NAME}:latest`;

  if (imageExists(versionedTag)) {
    LogSink.info(`Reusing ${versionedTag}`, TraceTags.DEBUG);
    return;
  }

  LogSink.info(`Building ${versionedTag}...`, TraceTags.DEBUG);
  const args = buildPiRunnerImageArgs(version);
  try {
    execFileSync('docker', args, { stdio: 'inherit' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to build ${versionedTag}.\n` + `Run manually:\n  docker ${args.join(' ')}\n` + `Error: ${msg}`,
    );
  }

  LogSink.info(`Built ${versionedTag} (also tagged ${latestTag})`, TraceTags.DEBUG);
}

/**
 * Lazily ensure a derived `lgr-pi-runner-derived:<hash>-<version>` image
 * exists for the given base image. Returns the resolved tag, which callers
 * should pass to `docker run` instead of the configured base.
 *
 * The default base (`node:lts-slim`) bypasses the derive step and returns the
 * standard `lgr-pi-runner:latest` tag — the default image already covers it.
 */
export function ensurePiRunnerForBase(baseImage: string): string {
  if (baseImage === DEFAULT_BASE_IMAGE) {
    return `${IMAGE_NAME}:latest`;
  }

  const version = resolvePiVersion();
  const tag = derivedTagForBase(baseImage, version);

  if (imageExists(tag)) {
    return tag;
  }

  LogSink.info(`Building ${tag} from ${baseImage}...`, TraceTags.DEBUG);
  const args = buildPiRunnerImageArgs(version, { baseImage, tag });
  try {
    execFileSync('docker', args, { stdio: 'inherit' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to build derived runner ${tag} from ${baseImage}.\n` +
        `Run manually:\n  docker ${args.join(' ')}\n` +
        `Error: ${msg}`,
    );
  }

  LogSink.info(`Built ${tag}`, TraceTags.DEBUG);
  return tag;
}
