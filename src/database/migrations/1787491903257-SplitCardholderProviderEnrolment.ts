import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moves what an issuer decided off `cardholder` and onto `cardholder_enrolment`,
 * one row per issuer.
 *
 * The backfill copies every value verbatim, timestamps included.
 * `provider_cardholder_id` in particular is what an issuer is addressed by, so
 * a rewritten one strands every card behind it.
 */
export class SplitCardholderProviderEnrolment1787491903257
  implements MigrationInterface
{
  name = 'SplitCardholderProviderEnrolment1787491903257';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`cardholder_enrolment\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`cardholder_id\` bigint UNSIGNED NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`provider_cardholder_id\` varchar(80) NULL, \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', \`kyc_generation\` varchar(20) NULL, \`kyc_revision\` varchar(20) NULL, \`reason_code\` varchar(40) NULL, \`message\` varchar(255) NULL, \`response_payload\` json NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_cardholder_enrolment_status\` (\`status\`), INDEX \`idx_cardholder_enrolment_provider\` (\`provider_key\`, \`provider_cardholder_id\`), UNIQUE INDEX \`uq_cardholder_enrolment_provider\` (\`cardholder_id\`, \`provider_key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_enrolment\` ADD CONSTRAINT \`FK_eeaa9fcb5deeca2a5853a6f4250\` FOREIGN KEY (\`cardholder_id\`) REFERENCES \`cardholder\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `INSERT INTO \`cardholder_enrolment\` (\`cardholder_id\`, \`provider_key\`, \`provider_cardholder_id\`, \`status\`, \`kyc_generation\`, \`kyc_revision\`, \`reason_code\`, \`message\`, \`response_payload\`, \`created_at\`, \`updated_at\`) SELECT \`id\`, \`provider_key\`, \`provider_cardholder_id\`, \`status\`, \`kyc_generation\`, \`kyc_revision\`, \`reason_code\`, \`message\`, \`response_payload\`, \`created_at\`, \`updated_at\` FROM \`cardholder\``,
    );

    // Placed here because this is the last point at which nothing has been
    // destroyed. DDL implicitly commits, so the migration's transaction cannot
    // roll back the statements below — and the first of them drops the column
    // the new event reference was derived from. Failing here leaves only an
    // empty table to drop before re-running.
    const [counts] = (await queryRunner.query(
      `SELECT (SELECT COUNT(*) FROM \`cardholder\`) AS \`cardholders\`, (SELECT COUNT(*) FROM \`cardholder_enrolment\`) AS \`enrolments\``,
    )) as [{ cardholders: number | string; enrolments: number | string }];
    if (String(counts.cardholders) !== String(counts.enrolments)) {
      throw new Error(
        `Refusing to migrate: ${String(counts.cardholders)} cardholders backfilled to ${String(counts.enrolments)} enrolments`,
      );
    }

    // Must run before `cardholder`'s columns are dropped: the join is what the
    // new reference is derived from.
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` ADD \`cardholder_enrolment_id\` bigint UNSIGNED NULL`,
    );
    await queryRunner.query(
      `UPDATE \`cardholder_event\` e JOIN \`cardholder_enrolment\` en ON en.\`cardholder_id\` = e.\`cardholder_id\` SET e.\`cardholder_enrolment_id\` = en.\`id\``,
    );

    // Checked explicitly, and while `cardholder_id` still exists. The
    // `MODIFY ... NOT NULL` below is not this check: under a non-strict
    // `sql_mode` it rewrites an unmatched NULL to `0` rather than refusing,
    // and by then the column this value came from is gone.
    const [unmatched] = (await queryRunner.query(
      `SELECT COUNT(*) AS \`orphans\` FROM \`cardholder_event\` WHERE \`cardholder_enrolment_id\` IS NULL`,
    )) as [{ orphans: number | string }];
    if (Number(unmatched.orphans) !== 0) {
      throw new Error(
        `Refusing to migrate: ${String(unmatched.orphans)} cardholder_event rows found no enrolment`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` DROP FOREIGN KEY \`FK_f7bfbecb41b1929ad83efcecbd1\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_event_created\` ON \`cardholder_event\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` DROP COLUMN \`cardholder_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` MODIFY \`cardholder_enrolment_id\` bigint UNSIGNED NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_cardholder_event_created\` ON \`cardholder_event\` (\`cardholder_enrolment_id\`, \`created_at\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` ADD CONSTRAINT \`FK_77165c9296a255c44caafd52d9f\` FOREIGN KEY (\`cardholder_enrolment_id\`) REFERENCES \`cardholder_enrolment\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_provider\` ON \`cardholder\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_status\` ON \`cardholder\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder\` DROP COLUMN \`response_payload\`, DROP COLUMN \`message\`, DROP COLUMN \`reason_code\`, DROP COLUMN \`kyc_revision\`, DROP COLUMN \`kyc_generation\`, DROP COLUMN \`status\`, DROP COLUMN \`provider_cardholder_id\`, DROP COLUMN \`provider_key\``,
    );
  }

  /**
   * Not symmetric: eight columns can hold one issuer's answer, so a person
   * holding several enrolments keeps only their earliest and loses the rest.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`cardholder\` ADD \`provider_key\` varchar(20) NOT NULL, ADD \`provider_cardholder_id\` varchar(80) NULL, ADD \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', ADD \`kyc_generation\` varchar(20) NULL, ADD \`kyc_revision\` varchar(20) NULL, ADD \`reason_code\` varchar(40) NULL, ADD \`message\` varchar(255) NULL, ADD \`response_payload\` json NULL`,
    );
    await queryRunner.query(
      `UPDATE \`cardholder\` c JOIN \`cardholder_enrolment\` en ON en.\`id\` = (SELECT MIN(\`id\`) FROM \`cardholder_enrolment\` WHERE \`cardholder_id\` = c.\`id\`) SET c.\`provider_key\` = en.\`provider_key\`, c.\`provider_cardholder_id\` = en.\`provider_cardholder_id\`, c.\`status\` = en.\`status\`, c.\`kyc_generation\` = en.\`kyc_generation\`, c.\`kyc_revision\` = en.\`kyc_revision\`, c.\`reason_code\` = en.\`reason_code\`, c.\`message\` = en.\`message\`, c.\`response_payload\` = en.\`response_payload\``,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_cardholder_status\` ON \`cardholder\` (\`status\`)`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_cardholder_provider\` ON \`cardholder\` (\`provider_key\`, \`provider_cardholder_id\`)`,
    );

    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` ADD \`cardholder_id\` bigint UNSIGNED NULL`,
    );
    await queryRunner.query(
      `UPDATE \`cardholder_event\` e JOIN \`cardholder_enrolment\` en ON en.\`id\` = e.\`cardholder_enrolment_id\` SET e.\`cardholder_id\` = en.\`cardholder_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` DROP FOREIGN KEY \`FK_77165c9296a255c44caafd52d9f\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_event_created\` ON \`cardholder_event\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` DROP COLUMN \`cardholder_enrolment_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` MODIFY \`cardholder_id\` bigint UNSIGNED NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_cardholder_event_created\` ON \`cardholder_event\` (\`cardholder_id\`, \`created_at\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` ADD CONSTRAINT \`FK_f7bfbecb41b1929ad83efcecbd1\` FOREIGN KEY (\`cardholder_id\`) REFERENCES \`cardholder\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `ALTER TABLE \`cardholder_enrolment\` DROP FOREIGN KEY \`FK_eeaa9fcb5deeca2a5853a6f4250\``,
    );
    await queryRunner.query(`DROP TABLE \`cardholder_enrolment\``);
  }
}
