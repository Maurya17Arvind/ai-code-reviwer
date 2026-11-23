#!/usr/bin/env node
import { CommanderError } from 'commander';
import { CliError, processIO } from './core/cli-context';
import { buildProgram } from './program';

const io = processIO();

buildProgram(io)
  .exitOverride()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    if (error instanceof CommanderError) {
      // Help/version exit with 0; usage errors were already printed by commander.
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof CliError) {
      io.err(`error: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    io.err(`error: unexpected failure — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
