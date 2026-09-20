/**
 * Environment for the API layer.
 *
 * In development Vite loads .env files and hands them over via configureEnv(); in production the
 * process environment is all there is. Both end up in the same object, so route code never has to
 * know which one it is running under.
 */
export const env: Record<string, string | undefined> = { ...process.env };

export function configureEnv(values: Record<string, string | undefined>) {
  Object.assign(env, values);
}

export function getHfToken(): string {
  return env.HF_TOKEN || env.VITE_HF_TOKEN || '';
}
