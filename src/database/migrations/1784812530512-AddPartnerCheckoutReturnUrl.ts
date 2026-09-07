import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddPartnerCheckoutReturnUrl1784812530512
  implements MigrationInterface
{
  name = 'AddPartnerCheckoutReturnUrl1784812530512';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const columnExists = await queryRunner.hasColumn(
      'partner',
      'checkout_return_url',
    );
    if (!columnExists) {
      await queryRunner.query(
        'ALTER TABLE `partner` ADD `checkout_return_url` varchar(500) NULL',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const columnExists = await queryRunner.hasColumn(
      'partner',
      'checkout_return_url',
    );
    if (columnExists) {
      await queryRunner.query(
        'ALTER TABLE `partner` DROP COLUMN `checkout_return_url`',
      );
    }
  }
}
