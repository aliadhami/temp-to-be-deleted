import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCardProductTable1786818579295 implements MigrationInterface {
  name = 'CreateCardProductTable1786818579295';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`card_product\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`provider_product_id\` varchar(80) NOT NULL, \`display_name\` varchar(150) NOT NULL, \`card_type\` varchar(20) NOT NULL, \`card_organisation\` varchar(20) NOT NULL, \`material\` varchar(20) NULL, \`currency_code\` varchar(16) NOT NULL, \`issuance_fee_amount\` varchar(32) NULL, \`issuance_fee_currency\` varchar(16) NULL, \`annual_fee_amount\` varchar(32) NULL, \`annual_fee_currency\` varchar(16) NULL, \`deposit_fee_percent\` varchar(32) NULL, \`deposit_min_per_transaction\` varchar(32) NULL, \`deposit_max_per_transaction\` varchar(32) NULL, \`deposit_max_per_day\` varchar(32) NULL, \`requires_initial_deposit\` tinyint NOT NULL, \`deposit_min_initial\` varchar(32) NULL, \`application_mode\` varchar(32) NOT NULL, \`requires_kyc\` tinyint NOT NULL, \`activation_mode\` varchar(20) NOT NULL, \`activation_requires_identity_document\` tinyint NULL, \`available_for_issuance\` tinyint NOT NULL, \`raw_payload\` json NOT NULL, \`synced_at\` datetime(6) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_card_product_provider\` (\`provider_key\`, \`provider_product_id\`), UNIQUE INDEX \`IDX_d76fb54c3af604d4a1e5bf742f\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`IDX_d76fb54c3af604d4a1e5bf742f\` ON \`card_product\``,
    );
    await queryRunner.query(
      `DROP INDEX \`uq_card_product_provider\` ON \`card_product\``,
    );
    await queryRunner.query(`DROP TABLE \`card_product\``);
  }
}
