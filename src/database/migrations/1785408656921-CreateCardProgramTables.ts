import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCardProgramTables1785408656921
  implements MigrationInterface
{
  name = 'CreateCardProgramTables1785408656921';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`cardholder\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`partner_id\` bigint UNSIGNED NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`provider_cardholder_id\` varchar(80) NULL, \`first_name\` varchar(150) NOT NULL, \`last_name\` varchar(150) NOT NULL, \`email\` varchar(255) NOT NULL, \`phone\` varchar(20) NOT NULL, \`date_of_birth\` date NOT NULL, \`residential_address\` json NOT NULL, \`identity_provenance\` json NOT NULL, \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', \`kyc_generation\` varchar(20) NULL, \`kyc_revision\` varchar(20) NULL, \`reason_code\` varchar(40) NULL, \`message\` varchar(255) NULL, \`response_payload\` json NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_cardholder_provider\` (\`provider_key\`, \`provider_cardholder_id\`), INDEX \`idx_cardholder_status\` (\`status\`), INDEX \`idx_cardholder_partner\` (\`partner_id\`), UNIQUE INDEX \`IDX_9cbcc2d33e9ebb7368a8ccd5dc\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`card\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`partner_id\` bigint UNSIGNED NOT NULL, \`cardholder_id\` bigint UNSIGNED NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`provider_card_id\` varchar(80) NULL, \`card_type\` varchar(20) NOT NULL, \`name_on_card\` varchar(150) NOT NULL, \`currency\` varchar(3) NOT NULL, \`status\` varchar(20) NOT NULL DEFAULT 'NOT_ACTIVATED', \`masked_pan\` varchar(20) NULL, \`response_payload\` json NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_card_provider\` (\`provider_key\`, \`provider_card_id\`), INDEX \`idx_card_status\` (\`status\`), INDEX \`idx_card_cardholder\` (\`cardholder_id\`), INDEX \`idx_card_partner\` (\`partner_id\`), UNIQUE INDEX \`IDX_a9cc8bf531bd5324f4372158d6\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`card_event\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`card_id\` bigint UNSIGNED NOT NULL, \`from_status\` varchar(20) NULL, \`to_status\` varchar(20) NOT NULL, \`source\` varchar(20) NOT NULL, \`detail\` varchar(255) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_card_event_created\` (\`card_id\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`cardholder_event\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`cardholder_id\` bigint UNSIGNED NOT NULL, \`from_status\` varchar(24) NULL, \`to_status\` varchar(24) NOT NULL, \`source\` varchar(20) NOT NULL, \`detail\` varchar(255) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_cardholder_event_created\` (\`cardholder_id\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder\` ADD CONSTRAINT \`FK_cb477f664796e49c33f7dd605a5\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` ADD CONSTRAINT \`FK_8643679703049545382a4f01022\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` ADD CONSTRAINT \`FK_2d9d192e2740a7b44c3cb1f3c28\` FOREIGN KEY (\`cardholder_id\`) REFERENCES \`cardholder\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_event\` ADD CONSTRAINT \`FK_2376cf21fe50094c63ac9309d80\` FOREIGN KEY (\`card_id\`) REFERENCES \`card\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` ADD CONSTRAINT \`FK_f7bfbecb41b1929ad83efcecbd1\` FOREIGN KEY (\`cardholder_id\`) REFERENCES \`cardholder\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`cardholder_event\` DROP FOREIGN KEY \`FK_f7bfbecb41b1929ad83efcecbd1\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_event\` DROP FOREIGN KEY \`FK_2376cf21fe50094c63ac9309d80\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` DROP FOREIGN KEY \`FK_2d9d192e2740a7b44c3cb1f3c28\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` DROP FOREIGN KEY \`FK_8643679703049545382a4f01022\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`cardholder\` DROP FOREIGN KEY \`FK_cb477f664796e49c33f7dd605a5\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_event_created\` ON \`cardholder_event\``,
    );
    await queryRunner.query(`DROP TABLE \`cardholder_event\``);
    await queryRunner.query(
      `DROP INDEX \`idx_card_event_created\` ON \`card_event\``,
    );
    await queryRunner.query(`DROP TABLE \`card_event\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_a9cc8bf531bd5324f4372158d6\` ON \`card\``,
    );
    await queryRunner.query(`DROP INDEX \`idx_card_partner\` ON \`card\``);
    await queryRunner.query(`DROP INDEX \`idx_card_cardholder\` ON \`card\``);
    await queryRunner.query(`DROP INDEX \`idx_card_status\` ON \`card\``);
    await queryRunner.query(`DROP INDEX \`idx_card_provider\` ON \`card\``);
    await queryRunner.query(`DROP TABLE \`card\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_9cbcc2d33e9ebb7368a8ccd5dc\` ON \`cardholder\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_partner\` ON \`cardholder\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_status\` ON \`cardholder\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_cardholder_provider\` ON \`cardholder\``,
    );
    await queryRunner.query(`DROP TABLE \`cardholder\``);
  }
}
