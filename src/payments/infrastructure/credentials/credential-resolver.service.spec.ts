import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayKey } from '../../domain/gateway-key.enum';
import { CredentialEnvironment } from '../../../partners/domain/credential-environment.enum';
import { PartnerGatewayCredentialEntity } from '../../../partners/persistence/partner-gateway-credential.entity';
import { CredentialEncryptionService } from '../../../shared/crypto/credential-encryption.service';
import { CredentialResolver } from './credential-resolver';

describe('CredentialResolver', () => {
  let resolver: CredentialResolver;
  let credentialRepository: { findOne: jest.Mock };
  let encryptionService: { decrypt: jest.Mock };
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string | undefined;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    process.env.PAYMENTS_MLT_MERCHANT_ID = 'GLOBAL_MERCHANT';
    process.env.PAYMENTS_MLT_UAT_URL = 'https://global-uat.example.com';
    process.env.PAYMENTS_MLT_ENV = 'uat';

    credentialRepository = { findOne: jest.fn() };
    encryptionService = { decrypt: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialResolver,
        {
          provide: getRepositoryToken(PartnerGatewayCredentialEntity),
          useValue: credentialRepository,
        },
        { provide: ConfigService, useValue: {} },
        { provide: CredentialEncryptionService, useValue: encryptionService },
      ],
    }).compile();

    resolver = module.get(CredentialResolver);
  });

  afterEach(() => {
    process.env = originalEnv;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('returns global env credentials when partnerId is null', async () => {
    const result = await resolver.resolve({
      gatewayKey: GatewayKey.MLT,
      partnerId: null,
      environment: CredentialEnvironment.UAT,
    });
    expect(result.MERCHANT_ID).toBe('GLOBAL_MERCHANT');
  });

  it('returns global env credentials when no partner override exists', async () => {
    credentialRepository.findOne.mockResolvedValueOnce(null);
    const result = await resolver.resolve({
      gatewayKey: GatewayKey.MLT,
      partnerId: 'partner-1',
      environment: CredentialEnvironment.UAT,
    });
    expect(result.MERCHANT_ID).toBe('GLOBAL_MERCHANT');
  });

  it('resolves file-backed global credentials', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'credential-resolver-'));
    const passwordPath = join(tempDir, 'mlt-password');
    writeFileSync(passwordPath, 'file-secret\n');
    process.env.PAYMENTS_MLT_PASSWORD_FILE = passwordPath;

    const result = await resolver.resolve({
      gatewayKey: GatewayKey.MLT,
      partnerId: null,
      environment: CredentialEnvironment.UAT,
    });

    expect(result.PASSWORD).toBe('file-secret');
    expect(result.PASSWORD_FILE).toBeUndefined();
  });

  it('merges partner overrides on top of global config — URLs survive, secrets are overridden', async () => {
    credentialRepository.findOne.mockResolvedValueOnce({
      credentialsEncrypted: Buffer.from('encrypted'),
    });
    encryptionService.decrypt.mockReturnValueOnce(
      JSON.stringify({
        MERCHANT_ID: 'PARTNER_MERCHANT',
        SECRET_KEY: 'partner-secret',
      }),
    );

    const result = await resolver.resolve({
      gatewayKey: GatewayKey.MLT,
      partnerId: 'partner-1',
      environment: CredentialEnvironment.UAT,
    });

    expect(result.MERCHANT_ID).toBe('PARTNER_MERCHANT'); // overridden
    expect(result.SECRET_KEY).toBe('partner-secret'); // overridden
    expect(result.UAT_URL).toBe('https://global-uat.example.com'); // preserved from global
  });
});
