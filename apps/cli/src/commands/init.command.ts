import {
  parseReviewConfig,
  REVIEW_CONFIG_FILENAME,
  type ReviewConfigTemplateInput,
  renderReviewConfigTemplate,
} from '@acra/configuration';
import { type LocalGitProvider } from '@acra/git-providers-local';
import { resolveInsideRepo } from '@acra/security';
import { type Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { CliError, type CliIO, paint } from '../core/cli-context';
import { type GlobalOptions, openRepository } from '../core/workspace';

interface InitOptions {
  readonly force?: boolean;
}

export function registerInitCommand(program: Command, io: CliIO): void {
  program
    .command('init')
    .description(`create ${REVIEW_CONFIG_FILENAME} in the repository root (never stages or commits it)`)
    .option('-f, --force', `overwrite an existing ${REVIEW_CONFIG_FILENAME}`)
    .action(async (options: InitOptions, command: Command) => {
      const provider = await openRepository(io, command.optsWithGlobals<GlobalOptions>());
      const existing = await provider.readFile(REVIEW_CONFIG_FILENAME, { kind: 'worktree' });
      if (existing && !options.force) {
        throw new CliError(`${REVIEW_CONFIG_FILENAME} already exists. Use --force to overwrite it.`);
      }

      const detected = await detectProject(provider);
      const content = renderReviewConfigTemplate(detected);
      parseReviewConfig(content); // invariant: the template is always valid

      const target = resolveInsideRepo(provider.rootPath, REVIEW_CONFIG_FILENAME);
      await writeFile(target, content, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' });

      const detail = [detected.framework, detected.language].filter(Boolean).join(', ') || 'no framework detected';
      io.out(`${paint(io, 'green', '✔')} Created ${REVIEW_CONFIG_FILENAME} (${detail}).`);
      io.out('  The file is not staged or committed. Review it, then commit it with your changes.');
    });
}

/** Infers framework/language from package.json and tsconfig.json at the repository root. */
export async function detectProject(provider: LocalGitProvider): Promise<ReviewConfigTemplateInput> {
  const packageFile = await provider.readFile('package.json', { kind: 'worktree' });
  let dependencies: Record<string, unknown> = {};
  if (packageFile && !packageFile.isBinary && !packageFile.tooLarge) {
    try {
      const parsed = JSON.parse(packageFile.content) as Record<string, unknown>;
      dependencies = { ...asRecord(parsed['dependencies']), ...asRecord(parsed['devDependencies']) };
    } catch {
      // malformed package.json: fall back to no detection
    }
  }
  const has = (name: string) => Object.hasOwn(dependencies, name);
  const framework: ReviewConfigTemplateInput['framework'] = has('@angular/core')
    ? 'angular'
    : has('@nestjs/core')
      ? 'nestjs'
      : has('next')
        ? 'nextjs'
        : has('react')
          ? 'react'
          : has('vue')
            ? 'vue'
            : has('svelte')
              ? 'svelte'
              : has('express')
                ? 'express'
                : packageFile
                  ? 'node'
                  : undefined;

  const hasTsConfig = (await provider.readFile('tsconfig.json', { kind: 'worktree' })) !== null;
  const language: ReviewConfigTemplateInput['language'] =
    has('typescript') || hasTsConfig ? 'typescript' : packageFile ? 'javascript' : undefined;

  return { ...(framework ? { framework } : {}), ...(language ? { language } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
