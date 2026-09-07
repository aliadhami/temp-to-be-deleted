/** Org-level provider credentials, sourced only from global env config — no per-partner override, unlike GatewayCredentials. */
export type CardProviderCredentials = Readonly<Record<string, string>>;
