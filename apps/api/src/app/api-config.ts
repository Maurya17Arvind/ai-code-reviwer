import { type ApiEnv } from '@acra/configuration';

/** Injection token for the validated API configuration. */
export const API_CONFIG = Symbol('API_CONFIG');
export type ApiConfig = ApiEnv;
