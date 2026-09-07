import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateOperationsTables1784016603527 implements MigrationInterface {
    name = 'CreateOperationsTables1784016603527'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`audit_log\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`actor_user_id\` bigint UNSIGNED NULL, \`action\` varchar(60) NOT NULL, \`target_type\` varchar(40) NOT NULL, \`target_public_id\` char(36) NULL, \`before_json\` json NULL, \`after_json\` json NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_audit_actor\` (\`actor_user_id\`), INDEX \`idx_audit_action_created\` (\`action\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`fee_record\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`transaction_id\` bigint UNSIGNED NOT NULL, \`gateway_fee\` decimal(18,2) NOT NULL, \`partner_fee\` decimal(18,2) NULL, \`currency\` varchar(3) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_fee_transaction\` (\`transaction_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`gateway_callback_log\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`gateway_key\` varchar(20) NOT NULL, \`transaction_public_id\` char(36) NULL, \`signature_valid\` tinyint NOT NULL, \`raw_payload\` json NOT NULL, \`received_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_callback_gateway_received\` (\`gateway_key\`, \`received_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`payout\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`partner_id\` bigint UNSIGNED NULL, \`gateway_key\` varchar(20) NOT NULL, \`order_num\` varchar(64) NOT NULL, \`amount\` decimal(18,2) NOT NULL, \`currency\` varchar(3) NOT NULL, \`beneficiary_name\` varchar(150) NOT NULL, \`beneficiary_account\` varchar(64) NOT NULL, \`bank_code\` varchar(20) NULL, \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', \`provider_ref\` varchar(80) NULL, \`fee\` decimal(18,2) NULL, \`created_by\` bigint UNSIGNED NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_payout_partner\` (\`partner_id\`), INDEX \`idx_payout_status\` (\`status\`), UNIQUE INDEX \`uq_payout_gateway_order\` (\`gateway_key\`, \`order_num\`), UNIQUE INDEX \`IDX_57654ab6e222b19121f83c3235\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`payout_approval\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`payout_id\` bigint UNSIGNED NOT NULL, \`approver_id\` bigint UNSIGNED NOT NULL, \`decision\` varchar(20) NOT NULL, \`note\` varchar(255) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`refund\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`transaction_id\` bigint UNSIGNED NOT NULL, \`gateway_key\` varchar(20) NOT NULL, \`amount\` decimal(18,2) NOT NULL, \`status\` varchar(24) NOT NULL DEFAULT 'PENDING', \`provider_ref\` varchar(80) NULL, \`requested_by\` bigint UNSIGNED NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_refund_transaction\` (\`transaction_id\`), UNIQUE INDEX \`IDX_c6579e9fdd51c1ec9e0bfbb64b\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`CREATE TABLE \`routing_rule\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`priority\` int NOT NULL, \`match_currency\` varchar(3) NULL, \`match_country\` char(2) NULL, \`match_method\` varchar(20) NULL, \`match_partner_id\` bigint UNSIGNED NULL, \`primary_gateway\` varchar(20) NOT NULL, \`fallback_gateway\` varchar(20) NULL, \`is_active\` tinyint NOT NULL DEFAULT 1, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_rule_priority_active\` (\`priority\`, \`is_active\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`audit_log\` ADD CONSTRAINT \`FK_1c4c8c76598008ea972a84e7834\` FOREIGN KEY (\`actor_user_id\`) REFERENCES \`user_account\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`fee_record\` ADD CONSTRAINT \`FK_20c6cabe3c224115e88476b87d2\` FOREIGN KEY (\`transaction_id\`) REFERENCES \`payment_transaction\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`payout\` ADD CONSTRAINT \`FK_9a9f4864f36f02ddb7d39cf199f\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`payout\` ADD CONSTRAINT \`FK_bf365c899b7e99ca45d666b3987\` FOREIGN KEY (\`created_by\`) REFERENCES \`user_account\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`payout_approval\` ADD CONSTRAINT \`FK_e05c6d1089a039ff5742549b07f\` FOREIGN KEY (\`payout_id\`) REFERENCES \`payout\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`payout_approval\` ADD CONSTRAINT \`FK_ac1c1e0a3b5e7c9ff1a01432e61\` FOREIGN KEY (\`approver_id\`) REFERENCES \`user_account\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`refund\` ADD CONSTRAINT \`FK_74ffc5427c595968dd777f71bf4\` FOREIGN KEY (\`transaction_id\`) REFERENCES \`payment_transaction\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE \`refund\` ADD CONSTRAINT \`FK_b2f2cb8752c155c09ea305f40c6\` FOREIGN KEY (\`requested_by\`) REFERENCES \`user_account\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`refund\` DROP FOREIGN KEY \`FK_b2f2cb8752c155c09ea305f40c6\``);
        await queryRunner.query(`ALTER TABLE \`refund\` DROP FOREIGN KEY \`FK_74ffc5427c595968dd777f71bf4\``);
        await queryRunner.query(`ALTER TABLE \`payout_approval\` DROP FOREIGN KEY \`FK_ac1c1e0a3b5e7c9ff1a01432e61\``);
        await queryRunner.query(`ALTER TABLE \`payout_approval\` DROP FOREIGN KEY \`FK_e05c6d1089a039ff5742549b07f\``);
        await queryRunner.query(`ALTER TABLE \`payout\` DROP FOREIGN KEY \`FK_bf365c899b7e99ca45d666b3987\``);
        await queryRunner.query(`ALTER TABLE \`payout\` DROP FOREIGN KEY \`FK_9a9f4864f36f02ddb7d39cf199f\``);
        await queryRunner.query(`ALTER TABLE \`fee_record\` DROP FOREIGN KEY \`FK_20c6cabe3c224115e88476b87d2\``);
        await queryRunner.query(`ALTER TABLE \`audit_log\` DROP FOREIGN KEY \`FK_1c4c8c76598008ea972a84e7834\``);
        await queryRunner.query(`DROP INDEX \`idx_rule_priority_active\` ON \`routing_rule\``);
        await queryRunner.query(`DROP TABLE \`routing_rule\``);
        await queryRunner.query(`DROP INDEX \`IDX_c6579e9fdd51c1ec9e0bfbb64b\` ON \`refund\``);
        await queryRunner.query(`DROP INDEX \`idx_refund_transaction\` ON \`refund\``);
        await queryRunner.query(`DROP TABLE \`refund\``);
        await queryRunner.query(`DROP TABLE \`payout_approval\``);
        await queryRunner.query(`DROP INDEX \`IDX_57654ab6e222b19121f83c3235\` ON \`payout\``);
        await queryRunner.query(`DROP INDEX \`uq_payout_gateway_order\` ON \`payout\``);
        await queryRunner.query(`DROP INDEX \`idx_payout_status\` ON \`payout\``);
        await queryRunner.query(`DROP INDEX \`idx_payout_partner\` ON \`payout\``);
        await queryRunner.query(`DROP TABLE \`payout\``);
        await queryRunner.query(`DROP INDEX \`idx_callback_gateway_received\` ON \`gateway_callback_log\``);
        await queryRunner.query(`DROP TABLE \`gateway_callback_log\``);
        await queryRunner.query(`DROP INDEX \`idx_fee_transaction\` ON \`fee_record\``);
        await queryRunner.query(`DROP TABLE \`fee_record\``);
        await queryRunner.query(`DROP INDEX \`idx_audit_action_created\` ON \`audit_log\``);
        await queryRunner.query(`DROP INDEX \`idx_audit_actor\` ON \`audit_log\``);
        await queryRunner.query(`DROP TABLE \`audit_log\``);
    }

}
