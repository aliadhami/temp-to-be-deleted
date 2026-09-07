import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCardApplicationTable1786877821976
  implements MigrationInterface
{
  name = 'CreateCardApplicationTable1786877821976';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`card_application\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`card_id\` bigint UNSIGNED NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`request_id\` varchar(80) COLLATE "utf8mb4_nopad_bin" NOT NULL, \`card_product_id\` bigint UNSIGNED NULL, \`initial_deposit_amount\` varchar(32) NULL, \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', \`reason_code\` varchar(40) NULL, \`message\` varchar(255) NULL, \`response_payload\` json NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_card_application_status\` (\`status\`), UNIQUE INDEX \`uq_card_application_card\` (\`card_id\`), UNIQUE INDEX \`uq_card_application_provider_request\` (\`provider_key\`, \`request_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_application\` ADD CONSTRAINT \`FK_c2109a50c3b9fc319224d6e3976\` FOREIGN KEY (\`card_id\`) REFERENCES \`card\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_application\` ADD CONSTRAINT \`FK_0ec528c90dce910e3f263836690\` FOREIGN KEY (\`card_product_id\`) REFERENCES \`card_product\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_application\` DROP FOREIGN KEY \`FK_0ec528c90dce910e3f263836690\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_application\` DROP FOREIGN KEY \`FK_c2109a50c3b9fc319224d6e3976\``,
    );
    await queryRunner.query(
      `DROP INDEX \`uq_card_application_provider_request\` ON \`card_application\``,
    );
    await queryRunner.query(
      `DROP INDEX \`uq_card_application_card\` ON \`card_application\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_card_application_status\` ON \`card_application\``,
    );
    await queryRunner.query(`DROP TABLE \`card_application\``);
  }
}
