import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The expression behind `in_flight_card_id`. Duplicated from the entity rather
 * than imported: a migration is a record of what ran, and an import would let
 * a later edit rewrite history.
 */
const IN_FLIGHT_EXPRESSION =
  "IF(`status` IN ('DRAFT', 'SUBMITTED'), `card_id`, NULL)";

/**
 * One row per operation requested against a card that already exists, written
 * before the issuer is called, with "one in flight per card" enforced by a
 * unique index rather than by a read before the write.
 */
export class CreateCardOperationTable1787572114650
  implements MigrationInterface
{
  name = 'CreateCardOperationTable1787572114650';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A generated column's expression is compared against the row stored here,
    // never against the server's own normalised text, so without both this
    // table and the row below the column drifts on every `schema:log`.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`typeorm_metadata\` (\`type\` varchar(255) NOT NULL, \`database\` varchar(255) NULL, \`schema\` varchar(255) NULL, \`table\` varchar(255) NULL, \`name\` varchar(255) NULL, \`value\` text NULL) ENGINE=InnoDB`,
    );

    // `UNSIGNED` precedes the expression: the generator emits it after
    // `VIRTUAL`, which this server rejects.
    await queryRunner.query(
      `CREATE TABLE \`card_operation\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`card_id\` bigint UNSIGNED NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`request_reference\` varchar(36) COLLATE "utf8mb4_nopad_bin" NOT NULL, \`operation_type\` varchar(20) NOT NULL, \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', \`in_flight_card_id\` bigint UNSIGNED AS (${IN_FLIGHT_EXPRESSION}) VIRTUAL, \`reason_code\` varchar(40) NULL, \`message\` varchar(255) NULL, \`response_payload\` json NULL, \`status_checked_at\` datetime(6) NULL, \`escalated_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_card_operation_in_flight\` (\`in_flight_card_id\`), INDEX \`idx_card_operation_card_created\` (\`card_id\`, \`created_at\`), INDEX \`idx_card_operation_status_checked\` (\`status\`, \`status_checked_at\`), UNIQUE INDEX \`uq_card_operation_provider_reference\` (\`provider_key\`, \`request_reference\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );

    // The database name goes in `schema`, and `database` stays null — the
    // columns this driver reads back on. Reversing them fails silently: the
    // row is written and no lookup ever matches it.
    await queryRunner.query(
      `INSERT INTO \`typeorm_metadata\`(\`database\`, \`schema\`, \`table\`, \`type\`, \`name\`, \`value\`) VALUES (NULL, DATABASE(), ?, ?, ?, ?)`,
      [
        'card_operation',
        'GENERATED_COLUMN',
        'in_flight_card_id',
        IN_FLIGHT_EXPRESSION,
      ],
    );

    await queryRunner.query(
      `ALTER TABLE \`card_operation\` ADD CONSTRAINT \`FK_45aa04b9a32aaebf5089d31eb88\` FOREIGN KEY (\`card_id\`) REFERENCES \`card\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_operation\` DROP FOREIGN KEY \`FK_45aa04b9a32aaebf5089d31eb88\``,
    );
    // The table goes before its bookkeeping. DDL commits as it runs, so a
    // revert that stops half way must not leave a generated column whose
    // metadata row is gone — that is the state which drifts on every
    // `schema:log` with nothing to point at. An orphaned row is harmless: it is
    // only ever read for a column that exists.
    await queryRunner.query(`DROP TABLE \`card_operation\``);
    await queryRunner.query(
      `DELETE FROM \`typeorm_metadata\` WHERE \`type\` = ? AND \`name\` = ? AND \`schema\` = DATABASE() AND \`table\` = ?`,
      ['GENERATED_COLUMN', 'in_flight_card_id', 'card_operation'],
    );
    // `typeorm_metadata` is left standing, empty: it is the driver's own
    // bookkeeping rather than part of this schema.
  }
}
