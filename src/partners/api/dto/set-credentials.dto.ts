import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsObject } from 'class-validator';
import { GatewayKey } from '../../../payments/domain/gateway-key.enum';
import { CredentialEnvironment } from '../../domain/credential-environment.enum';

export class SetPartnerCredentialsDto {
  @ApiProperty({ enum: GatewayKey })
  @IsEnum(GatewayKey)
  gatewayKey!: GatewayKey;

  @ApiProperty({ enum: CredentialEnvironment })
  @IsEnum(CredentialEnvironment)
  environment!: CredentialEnvironment;

  @ApiProperty({
    description:
      'Raw credential fields for this gateway (e.g. merchantId, secretKey)',
    example: { merchantId: 'ABC123', secretKey: 'shh' },
  })
  @IsObject()
  credentials!: Record<string, string>;
}
