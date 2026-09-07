import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePartnerWebhookAndDeliveryTable1784783439112 implements MigrationInterface {
    name = 'CreatePartnerWebhookAndDeliveryTable1784783439112'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`webhook_delivery\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`partner_id\` bigint UNSIGNED NOT NULL, \`transaction_id\` bigint UNSIGNED NULL, \`event_type\` varchar(60) NOT NULL, \`payload\` json NOT NULL, \`status\` varchar(20) NOT NULL DEFAULT 'PENDING', \`attempt_count\` int NOT NULL DEFAULT '0', \`next_attempt_at\` datetime(6) NULL, \`last_response_status\` int NULL, \`last_error\` varchar(500) NULL, \`delivered_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_webhook_delivery_partner\` (\`partner_id\`), INDEX \`idx_webhook_delivery_due\` (\`status\`, \`next_attempt_at\`), UNIQUE INDEX \`IDX_13f2171f6588b0fd3652a08752\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`partner\` ADD \`webhook_url\` varchar(500) NULL`);
        await queryRunner.query(`ALTER TABLE \`partner\` ADD \`webhook_secret_encrypted\` blob NULL`);
        await queryRunner.query(`ALTER TABLE \`webhook_delivery\` ADD CONSTRAINT \`FK_f25e0fa9a1d2388b8c5c7eafb27\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`webhook_delivery\` ADD CONSTRAINT \`FK_6395a7271f261ba9907c7e9f2e4\` FOREIGN KEY (\`transaction_id\`) REFERENCES \`payment_transaction\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`webhook_delivery\` DROP FOREIGN KEY \`FK_6395a7271f261ba9907c7e9f2e4\``);
        await queryRunner.query(`ALTER TABLE \`webhook_delivery\` DROP FOREIGN KEY \`FK_f25e0fa9a1d2388b8c5c7eafb27\``);
        await queryRunner.query(`ALTER TABLE \`partner\` DROP COLUMN \`webhook_secret_encrypted\``);
        await queryRunner.query(`ALTER TABLE \`partner\` DROP COLUMN \`webhook_url\``);
        await queryRunner.query(`DROP INDEX \`IDX_13f2171f6588b0fd3652a08752\` ON \`webhook_delivery\``);
        await queryRunner.query(`DROP INDEX \`idx_webhook_delivery_due\` ON \`webhook_delivery\``);
        await queryRunner.query(`DROP INDEX \`idx_webhook_delivery_partner\` ON \`webhook_delivery\``);
        await queryRunner.query(`DROP TABLE \`webhook_delivery\``);
    }

}
