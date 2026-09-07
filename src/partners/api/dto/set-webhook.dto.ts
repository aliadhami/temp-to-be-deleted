import { ApiProperty } from '@nestjs/swagger';
import { IsUrl } from 'class-validator';

export class SetPartnerWebhookDto {
  @ApiProperty({ example: 'https://partner.example.com/webhooks/payments' })
  @IsUrl({ require_tld: false }) // allows http://localhost URLs for local testing
  webhookUrl!: string;
}
