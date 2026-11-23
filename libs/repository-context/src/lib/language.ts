const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  sql: 'sql',
  py: 'python',
  java: 'java',
  kt: 'kotlin',
  go: 'go',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  rs: 'rust',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  xml: 'xml',
  toml: 'toml',
};

const BY_FILENAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
};

/** Best-effort language identifier used for reviewer prompts and statistics. */
export function detectLanguage(path: string): string {
  const fileName = path.split('/').at(-1)?.toLowerCase() ?? '';
  const byName = BY_FILENAME[fileName];
  if (byName) return byName;
  if (fileName.startsWith('dockerfile')) return 'dockerfile';
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return BY_EXTENSION[fileName.slice(dot + 1)] ?? 'text';
}
