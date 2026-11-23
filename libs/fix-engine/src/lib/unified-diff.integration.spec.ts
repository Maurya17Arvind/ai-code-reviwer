import { TempGitRepo } from '@acra/testing';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyChanges, joinLines, splitLines, toChanges } from './text-lines';
import { createUnifiedDiff } from './unified-diff';

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('createUnifiedDiff produces patches git applies byte-for-byte', () => {
  let repo: TempGitRepo;
  beforeAll(() => {
    repo = TempGitRepo.create();
  });
  afterAll(() => repo.dispose());

  it.each(Array.from({ length: 150 }, (_, i) => i + 1))('random edit set #%i', (seed) => {
    const random = rng(seed);
    const lineCount = 1 + Math.floor(random() * 60);
    const eol = random() < 0.25 ? '\r\n' : '\n';
    const finalNewline = random() < 0.85;
    const lines = Array.from({ length: lineCount }, (_, i) => `l${i + 1} ${'x'.repeat(Math.floor(random() * 5))}`);
    const original = lines.join(eol) + (finalNewline ? eol : '');

    const edits: Array<{ startLine: number; endLine: number; added: string[] }> = [];
    let line = 1;
    while (line <= lineCount && edits.length < 5) {
      line += Math.floor(random() * 12);
      if (line > lineCount) break;
      const end = Math.min(lineCount, line + Math.floor(random() * 3));
      const added = Array.from({ length: Math.floor(random() * 4) }, (_, k) => `new ${seed}-${line}-${k}`);
      edits.push({ startLine: line, endLine: end, added });
      line = end + 1;
    }

    const text = splitLines(original);
    const changes = toChanges(text.lines, edits);
    if (changes.length === 0) return;
    const expected = joinLines(applyChanges(text, changes));
    const patch = createUnifiedDiff('file.txt', text, changes);

    const file = join(repo.root, 'file.txt');
    writeFileSync(file, original);
    writeFileSync(join(repo.root, 'fix.patch'), patch);
    repo.git('apply', '--check', 'fix.patch');
    repo.git('apply', 'fix.patch');
    expect(readFileSync(file, 'utf8')).toBe(expected);
  });
});
