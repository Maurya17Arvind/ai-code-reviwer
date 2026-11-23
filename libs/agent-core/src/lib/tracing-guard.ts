/**
 * LangChain/LangGraph can export run traces (including prompts — i.e. source code) to LangSmith
 * when tracing environment variables are set. That would be an undeclared third-party data
 * egress, so it is switched off unless explicitly allowed with ACRA_ALLOW_LANGSMITH_TRACING=true.
 * Returns a warning when it had to override the environment.
 */
const TRACING_FLAGS = ['LANGSMITH_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_TRACING', 'LANGSMITH_TRACING_V2'];

export function disableThirdPartyTracing(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['ACRA_ALLOW_LANGSMITH_TRACING'] === 'true') return null;
  const enabled = TRACING_FLAGS.filter((flag) => /^(true|1)$/i.test(env[flag] ?? ''));
  for (const flag of TRACING_FLAGS) env[flag] = 'false';
  return enabled.length > 0
    ? `LangSmith tracing (${enabled.join(', ')}) was disabled to prevent sending source code to a third party. Set ACRA_ALLOW_LANGSMITH_TRACING=true to allow it.`
    : null;
}
