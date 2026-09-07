import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Currency columns were varchar(3), assuming ISO-4217 fiat codes. Crypto asset
 * codes are longer — "USDT" is 4 chars, and SunPay's webhook reports composite
 * codes like "TRC20_USDT" (10). At varchar(3) MariaDB would either truncate
 * "USDT" to "USD" — silently indistinguishable from real US dollars — or hard
 * error, depending on strict mode. Either outcome is unacceptable for money.
 *
 * varchar(3) -> varchar(20) is non-destructive: every existing value is 3 chars,
 * and both lengths stay under the 255-byte boundary in utf8mb4, so the length
 * prefix size is unchanged and MariaDB performs this in place.
 *
 * `card.currency` is deliberately left at varchar(3) — card programs are
 * fiat-denominated and out of scope here.
 *
 * NOTE: amount precision is not addressed here — that is the immediately
 * following migration, WidenMoneyColumnsForCryptoPrecision, which takes the
 * money columns to decimal(38,18). Run both or neither: this one alone lets you
 * store "USDT" while still rounding its amount to 2 decimal places.
 */
export class WidenCurrencyForCryptoAssets1786355163148 implements MigrationInterface {
  name = 'WidenCurrencyForCryptoAssets1786355163148';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` MODIFY COLUMN \`currency\` varchar(20) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payout\` MODIFY COLUMN \`currency\` varchar(20) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`fee_record\` MODIFY COLUMN \`currency\` varchar(20) NOT NULL`,
    );
  }

  /**
   * Reverting TRUNCATES any currency code longer than 3 characters. If crypto
   * transactions exist, this will corrupt their currency values — check before
   * running:
   *   SELECT DISTINCT currency FROM payment_transaction WHERE CHAR_LENGTH(currency) > 3;
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`fee_record\` MODIFY COLUMN \`currency\` varchar(3) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payout\` MODIFY COLUMN \`currency\` varchar(3) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` MODIFY COLUMN \`currency\` varchar(3) NOT NULL`,
    );
  }
}
