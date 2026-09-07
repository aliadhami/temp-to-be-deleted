import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CardProviderKey } from '../cards/domain/card-provider-key.enum';

/**
 * The HyperCard vars a request cannot be built without, and therefore the ones
 * that become required the moment the provider is enabled.
 */
const HYPERCARD_REQUIRED_KEYS = ['PAYMENTS_HYPERCARD_BASE_URL'] as const;

/**
 * Treat an empty string as absent before validating. Compose writes an unset
 * variable as `""`, not as nothing, so a stack that declares a HyperCard var
 * without setting it hands us an empty string.
 */
const optionalEnv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );

/**
 * A flag written as `true` or `false`, absent when unset. Left optional rather
 * than defaulted here because the default depends on `NODE_ENV`, which is
 * settled in the transform at the bottom of this file.
 */
const optionalFlagEnv = z.preprocess((value) => {
  if (value === '' || value === undefined) return undefined;
  if (typeof value !== 'string') return value;

  const normalised = value.trim().toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  // Anything else falls through to `z.boolean()`, so the failure names the
  // variable rather than being silently read as false.
  return value;
}, z.boolean().optional());

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    // MariaDB — mysql:// scheme is correct for the mysql2 driver
    DATABASE_URL: z
      .string()
      .url()
      .refine((url) => url.startsWith('mysql://'), {
        message: 'DATABASE_URL must be a mysql:// connection string',
      }),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_SECRET: z
      .string()
      .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    JWT_REFRESH_TTL: z.string().default('7d'),
    PAYMENTS_ENABLED_GATEWAYS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((key) => key.trim().toUpperCase())
          .filter(Boolean),
      ),
    CREDENTIALS_ENCRYPTION_KEY: z
      .string()
      .min(32, 'CREDENTIALS_ENCRYPTION_KEY must be at least 32 characters'),
    PAYMENTS_CALLBACK_BASE_URL: z.string().url(),
    PAYMENTS_MLT_ENV: z.string().default('uat'),
    PAYMENTS_AXYS_ENV: z.string().default('uat'),
    PAYMENTS_AXYS_BASE_URL: z.string().url(),
    VAULT_ADDR: z.string().url(),
    VAULT_CACERT_PATH: z.string(),
    VAULT_ROLE_ID_FILE: z.string(),
    VAULT_SECRET_ID_FILE: z.string(),
    VAULT_MOUNT_PATH: z.string().default('blockpay'),
    VAULT_ENVIRONMENT: z.enum(['dev', 'staging', 'prod']),
    PAYMENTS_ENABLED_CARD_PROVIDERS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((key) => key.trim().toUpperCase())
          .filter(Boolean),
      ),
    /**
     * How long a persisted card-product snapshot is served before the read
     * endpoint refreshes it from the provider.
     */
    CARD_PRODUCT_CATALOGUE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(3600),
    /**
     * Whether a past-its-window snapshot is refreshed from the provider on the
     * read path. Defaults off under `NODE_ENV=test` — see
     * `SCHEDULED_SWEEPS_ENABLED` for why, and note the refresh withdraws every
     * stored row the provider's live listing omits, which under test is every
     * row another spec seeded.
     */
    CARD_PRODUCT_CATALOGUE_REFRESH_ON_READ: optionalFlagEnv,
    /**
     * Whether the background sweeps register their timers at all. Defaults off
     * under `NODE_ENV=test`: the e2e run boots one whole application per spec
     * file against one shared schema, so an enabled timer is twenty-odd copies
     * of the same pass rewriting each other's fixtures. Every spec that tests
     * a sweep drives its use case directly and is unaffected.
     */
    SCHEDULED_SWEEPS_ENABLED: optionalFlagEnv,
    /**
     * How often the sweep asks issuers what became of the card applications
     * they have acknowledged. Provider-neutral for the reason the catalogue
     * window above is.
     */
    CARD_APPLICATION_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    /**
     * How many applications one pass of that sweep may examine. Bounded
     * because each one is a live call, so an unbounded pass on a deep backlog
     * would run until the backlog cleared and overlap the pass behind it.
     */
    CARD_APPLICATION_SWEEP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(50),
    /**
     * How often the sweep asks issuers what became of the deposits they have
     * accepted. Provider-neutral for the reason the ones above are.
     */
    CARD_DEPOSIT_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    /**
     * How many deposits one pass of that sweep may examine. Bounded because
     * each one is a live call, so an unbounded pass on a deep backlog would
     * run until the backlog cleared and overlap the pass behind it.
     */
    CARD_DEPOSIT_SWEEP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(50),
    /**
     * How often the sweep asks issuers what became of a lifecycle operation
     * they acknowledged. **Deliberately not the 60 seconds its neighbours use**:
     * one issuer has these worked by hand over hours, where a minute's cadence
     * is thousands of live calls per operation — and not hours either, one
     * having been observed applying an operation in under ten minutes.
     */
    CARD_OPERATION_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(300),
    /**
     * How many operations one pass of that sweep may examine. Bounded because
     * each is a live call, so an unbounded pass on a deep backlog would overlap
     * the pass behind it.
     */
    CARD_OPERATION_SWEEP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(50),
    /**
     * How long an operation may sit unanswered before the sweep warns about it
     * once. Past the longest an issuer claims to take — two *working* days,
     * four calendar ones across a weekend. **It only decides whether a warning
     * is logged**; nothing on a timer moves an operation's status.
     */
    CARD_OPERATION_ESCALATION_AFTER_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(345_600),
    /**
     * How often the sweep re-reads what an issuer says a card holds. Provider-
     * neutral for the reason the ones above are.
     */
    CARD_BALANCE_SWEEP_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60),
    /** How many cards one pass of that sweep may examine. */
    CARD_BALANCE_SWEEP_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .default(50),
    // An enum, not a bare string: this value gates the mock endpoints under
    // /openapi/card/mock/*, which their docs state do not exist in production.
    // A typo like 'prod' would leave that surface reachable against real cards.
    PAYMENTS_HYPERCARD_ENV: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.enum(['sandbox', 'production']).default('sandbox'),
    ),
    // Optional *as declared*, then required by the superRefine below whenever
    // PAYMENTS_ENABLED_CARD_PROVIDERS names hypercard.
    //
    // The only HyperCard variable left here: their API key and all three RSA
    // keys are read from Vault at first use, not from the environment. See
    // `SecretsProviderPort` for why there is no env-var fallback.
    PAYMENTS_HYPERCARD_BASE_URL: optionalEnv(z.string().url()),
  })
  .passthrough()
  .superRefine((env, ctx) => {
    // A provider's configuration is required exactly when that provider is
    // enabled. Its *credentials* are not checked here at all — those live in
    // Vault and are resolved on first use.
    if (
      !env.PAYMENTS_ENABLED_CARD_PROVIDERS.includes(CardProviderKey.HYPERCARD)
    )
      return;

    for (const key of HYPERCARD_REQUIRED_KEYS) {
      if (env[key]) continue;

      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when PAYMENTS_ENABLED_CARD_PROVIDERS includes "${CardProviderKey.HYPERCARD}"`,
      });
    }
  })
  /**
   * Settles the two flags that default from the environment rather than from a
   * constant. Both are off under test, where every spec boots its own
   * application against the one shared schema — a timer or a refresh there is
   * one process rewriting rows another is asserting on.
   */
  .transform((env) => ({
    ...env,
    SCHEDULED_SWEEPS_ENABLED:
      env.SCHEDULED_SWEEPS_ENABLED ?? env.NODE_ENV !== 'test',
    CARD_PRODUCT_CATALOGUE_REFRESH_ON_READ:
      env.CARD_PRODUCT_CATALOGUE_REFRESH_ON_READ ?? env.NODE_ENV !== 'test',
  }));

export type Env = z.infer<typeof envSchema>;

/**
 * Secrets a deployment may hand us as a path to a file rather than as a value.
 */
const fileBackedKeys = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'CREDENTIALS_ENCRYPTION_KEY',
] as const;

const applyFileBackedSecrets = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const resolved = { ...config };

  for (const key of fileBackedKeys) {
    const currentValue = resolved[key];
    if (typeof currentValue === 'string' && currentValue.length > 0) continue;

    const filePath = resolved[`${key}_FILE`];
    if (typeof filePath !== 'string' || filePath.length === 0) continue;

    try {
      resolved[key] = readFileSync(filePath, 'utf8').trimEnd();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read secret file for ${key}: ${message}`);
    }
  }

  return resolved;
};

export const validateEnv = (config: Record<string, unknown>): Env => {
  const result = envSchema.safeParse(applyFileBackedSecrets(config));
  if (result.success) return result.data;

  const issues = result.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Environment validation failed:\n${issues}`);
};
