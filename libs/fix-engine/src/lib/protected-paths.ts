import picomatch from 'picomatch';

/**
 * Files an AI-generated fix may never modify, whatever the finding says. Changes there can execute
 * code on CI or developer machines (workflows, hooks, package scripts), widen dependencies
 * (manifests, lockfiles), or alter review/approval behaviour (ai-review.yaml). A human can still
 * change them by hand — this only limits what the fix engine proposes.
 */
export const PROTECTED_PATH_GLOBS: readonly string[] = [
  '.git/**',
  '**/.git/**',
  '.github/**',
  '.gitlab-ci.yml',
  '.gitlab/**',
  '**/.circleci/**',
  '**/Jenkinsfile',
  '**/azure-pipelines.yml',
  '**/.husky/**',
  '**/.githooks/**',
  '**/.gitattributes',
  '**/.gitmodules',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/yarn.lock',
  '**/.npmrc',
  '**/.yarnrc*',
  '**/Dockerfile',
  '**/docker-compose*.yml',
  '**/Makefile',
  '**/.env',
  '**/.env.*',
  'ai-review.yaml',
  '**/*.pem',
  '**/*.key',
];

const isProtected = picomatch([...PROTECTED_PATH_GLOBS], { dot: true, nocase: true });

export function isProtectedPath(path: string): boolean {
  return isProtected(path);
}
