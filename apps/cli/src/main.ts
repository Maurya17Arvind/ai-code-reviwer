#!/usr/bin/env node
import { buildProgram } from './program';

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unexpected error');
    process.exitCode = 1;
  });
