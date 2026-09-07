import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePartnerApiKey1784543898318 implements MigrationInterface {
    name = 'CreatePartnerApiKey1784543898318'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`partner_api_key\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`partner_id\` bigint UNSIGNED NOT NULL, \`key_id\` varchar(32) NOT NULL, \`secret_hash\` char(64) NOT NULL, \`label\` varchar(100) NULL, \`status\` varchar(20) NOT NULL DEFAULT 'ACTIVE', \`last_used_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_api_key_partner\` (\`partner_id\`), UNIQUE INDEX \`idx_api_key_key_id\` (\`key_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
        await queryRunner.query(`ALTER TABLE \`partner_api_key\` ADD CONSTRAINT \`FK_33c488e5751ae0eb124e5e11b1d\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`partner_api_key\` DROP FOREIGN KEY \`FK_33c488e5751ae0eb124e5e11b1d\``);
        await queryRunner.query(`DROP INDEX \`idx_api_key_key_id\` ON \`partner_api_key\``);
        await queryRunner.query(`DROP INDEX \`idx_api_key_partner\` ON \`partner_api_key\``);
        await queryRunner.query(`DROP TABLE \`partner_api_key\``);
    }

}
