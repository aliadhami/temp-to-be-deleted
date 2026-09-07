export interface MltGatewayConfig {
  gatewayUrl: string;
  paymentChannel: string;
  currency: string;
}

/**
 * Picks the correct base URL from the credentials bag resolved for this
 * transaction (global env or per-partner override) based on which
 * environment that credential set targets.
 */
export const resolveMltGatewayUrl = (
  credentials: Readonly<Record<string, string>>,
): string => {
  const env = credentials.ENV;
  const url = env === 'production' ? credentials.PROD_URL : credentials.UAT_URL;
  if (!url) {
    throw new Error(
      `MLT gateway URL is not configured for environment "${env}" — check PAYMENTS_MLT_UAT_URL / PAYMENTS_MLT_PROD_URL or the partner's stored credentials`,
    );
  }
  return url.replace(/\/+$/, ''); // strip trailing slash(es) — caller appends its own path
};
