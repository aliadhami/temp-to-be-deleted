/**
 * Reads SunPay settings out of the credentials bag that CredentialResolver
 * assembled for this transaction — env vars under `PAYMENTS_SUNPAY_*` with the
 * prefix stripped, overlaid with any partner-specific overrides.
 */

export interface SunPayConfig {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Fallback chain when the caller didn't specify one. */
  defaultChain: string;
}

const requireValue = (
  credentials: Readonly<Record<string, string>>,
  key: string,
): string => {
  const value = credentials[key];
  if (!value) {
    throw new Error(
      `SunPay credential "${key}" is not configured — check PAYMENTS_SUNPAY_${key} or the partner's stored credentials`,
    );
  }
  return value;
};

export const resolveSunPayConfig = (
  credentials: Readonly<Record<string, string>>,
): SunPayConfig => {
  const environment = credentials.ENV;
  const baseUrl =
    environment === 'production'
      ? credentials.PROD_URL
      : credentials.SANDBOX_URL;

  if (!baseUrl) {
    throw new Error(
      `SunPay base URL is not configured for environment "${environment ?? 'sandbox'}" — check PAYMENTS_SUNPAY_SANDBOX_URL / PAYMENTS_SUNPAY_PROD_URL`,
    );
  }

  return {
    // Trailing slashes stripped — callers always append their own path.
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: requireValue(credentials, 'API_KEY'),
    apiSecret: requireValue(credentials, 'API_SECRET'),
    defaultChain: credentials.DEFAULT_CHAIN || 'TRON',
  };
};
