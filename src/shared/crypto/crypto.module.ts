import { Module } from '@nestjs/common';
import { CredentialEncryptionService } from './credential-encryption.service';

@Module({
  providers: [CredentialEncryptionService],
  exports: [CredentialEncryptionService],
})
export class CryptoModule {}
