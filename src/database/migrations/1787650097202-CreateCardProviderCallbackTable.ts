import { MigrationInterface, QueryRunner } from 'typeorm';

/** Duplicated from the entity, not imported: a migration records what ran. */
const DEDUPE_EXPRESSION =
  "IF(`signature_valid`, CONCAT(CHAR_LENGTH(`provider_key`), ':', `provider_key`, `delivery_key`), NULL)";

export class CreateCardProviderCallbackTable1787650097202
  implements MigrationInterface
{
  name = 'CreateCardProviderCallbackTable1787650097202';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Not redundant: the driver pre-creates this only while some entity still
    // declares a generated column.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`typeorm_metadata\` (\`type\` varchar(255) NOT NULL, \`database\` varchar(255) NULL, \`schema\` varchar(255) NULL, \`table\` varchar(255) NULL, \`name\` varchar(255) NULL, \`value\` text NULL) ENGINE=InnoDB`,
    );

    await queryRunner.query(
      `CREATE TABLE \`card_provider_callback\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`provider_key\` varchar(20) NOT NULL, \`event_label\` varchar(64) NULL, \`signature_valid\` tinyint NOT NULL, \`payload\` json NOT NULL, \`headers\` json NULL, \`delivery_key\` varchar(128) COLLATE "utf8mb4_nopad_bin" NOT NULL, \`dedupe_key\` varchar(160) COLLATE "utf8mb4_nopad_bin" AS (${DEDUPE_EXPRESSION}) VIRTUAL, \`processed_at\` datetime(6) NULL, \`attempt_count\` int NOT NULL DEFAULT '0', \`last_error\` varchar(500) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_card_provider_callback_dedupe\` (\`dedupe_key\`), INDEX \`idx_card_provider_callback_received\` (\`provider_key\`, \`created_at\`), INDEX \`idx_card_provider_callback_delivery\` (\`provider_key\`, \`delivery_key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );

    // Without this row the column drifts on every `schema:log` — TypeORM
    // compares against it, never against the server's own text. Database name
    // in `schema`, `database` null, and `DATABASE()` rather than the literal
    // the generator emits.
    await queryRunner.query(
      `INSERT INTO \`typeorm_metadata\`(\`database\`, \`schema\`, \`table\`, \`type\`, \`name\`, \`value\`) VALUES (NULL, DATABASE(), ?, ?, ?, ?)`,
      [
        'card_provider_callback',
        'GENERATED_COLUMN',
        'dedupe_key',
        DEDUPE_EXPRESSION,
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Table before bookkeeping: DDL commits as it runs, and a generated column
    // whose metadata row is gone drifts for ever. An orphan row is harmless.
    await queryRunner.query(`DROP TABLE \`card_provider_callback\``);
    await queryRunner.query(
      `DELETE FROM \`typeorm_metadata\` WHERE \`type\` = ? AND \`name\` = ? AND \`schema\` = DATABASE() AND \`table\` = ?`,
      ['GENERATED_COLUMN', 'dedupe_key', 'card_provider_callback'],
    );
  }
}
