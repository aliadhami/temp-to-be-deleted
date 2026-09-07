import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  PartnerApiKeyEntity,
  PartnerApiKeyStatus,
} from '../persistence/partner-api-key.entity';
import { PartnerEntity } from '../persistence/partner.entity';
import { PartnerApiKeyService } from './partner-api-key.service';
import { ApiKeyScope } from '../domain/api-key-scope.enum';

describe('PartnerApiKeyService', () => {
  let service: PartnerApiKeyService;
  let apiKeyRepository: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let partnerRepository: { findOne: jest.Mock };

  const partner: Partial<PartnerEntity> = {
    id: '1',
    publicId: 'partner-public-id',
  };

  beforeEach(async () => {
    apiKeyRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((input: unknown) => input),
      save: jest.fn(),
    };
    partnerRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerApiKeyService,
        {
          provide: getRepositoryToken(PartnerApiKeyEntity),
          useValue: apiKeyRepository,
        },
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
      ],
    }).compile();

    service = module.get(PartnerApiKeyService);
  });

  describe('create', () => {
    it('throws when the partner does not exist', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.create('missing', [ApiKeyScope.PAYMENTS]),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns a keyId.secret string and stores only a hash', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(partner);
      apiKeyRepository.save.mockImplementationOnce((entity) => entity);

      const result = await service.create(
        'partner-public-id',
        [ApiKeyScope.PAYMENTS],
        'Test key',
      );

      expect(result.apiKey).toMatch(/^pk_[0-9a-f]{12}\.[0-9a-f]{64}$/);
      const savedEntity = apiKeyRepository.save.mock.calls[0][0];
      expect(savedEntity.secretHash).toHaveLength(64); // sha256 hex
      expect(result.apiKey).not.toContain(savedEntity.secretHash);
    });
    it('persists and returns the requested scopes', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(partner);
      apiKeyRepository.save.mockImplementationOnce((entity) => entity);

      await service.create(
        'partner-public-id',
        [ApiKeyScope.PAYMENTS, ApiKeyScope.CARDS],
        'Full access key',
      );

      const savedEntity = apiKeyRepository.save.mock.calls[0][0];
      expect(savedEntity.scopes).toEqual([
        ApiKeyScope.PAYMENTS,
        ApiKeyScope.CARDS,
      ]);
    });
  });

  describe('verify', () => {
    const setupValidKey = async () => {
      partnerRepository.findOne.mockResolvedValueOnce(partner);
      apiKeyRepository.save.mockImplementation((entity) => entity);
      const { apiKey } = await service.create('partner-public-id', [
        ApiKeyScope.PAYMENTS,
      ]);
      const [keyId] = apiKey.split('.');
      const secretHash = apiKeyRepository.save.mock.calls[0][0].secretHash;
      return { apiKey, keyId, secretHash };
    };

    it('returns null for a malformed key (no separator)', async () => {
      const result = await service.verify('not-a-valid-format');
      expect(result).toBeNull();
    });

    it('returns null when the keyId does not match any row', async () => {
      apiKeyRepository.findOne.mockResolvedValueOnce(null);
      const result = await service.verify('pk_unknown.somesecret');
      expect(result).toBeNull();
    });

    it('returns null when the secret is wrong for a valid keyId', async () => {
      const { keyId, secretHash } = await setupValidKey();
      apiKeyRepository.findOne.mockResolvedValueOnce({
        keyId,
        secretHash,
        partnerId: '1',
        partner: { publicId: 'partner-public-id' },
      });

      const result = await service.verify(`${keyId}.wrong-secret`);
      expect(result).toBeNull();
    });

    it('resolves the partner for a valid keyId + secret pair', async () => {
      const { apiKey, keyId, secretHash } = await setupValidKey();
      apiKeyRepository.findOne.mockResolvedValueOnce({
        keyId,
        secretHash,
        partnerId: '1',
        partner: { publicId: 'partner-public-id' },
      });
      apiKeyRepository.save.mockResolvedValueOnce({});

      const result = await service.verify(apiKey);
      expect(result).toEqual({
        partnerId: '1',
        partnerPublicId: 'partner-public-id',
      });
    });

    it('never matches a revoked key (query filters by ACTIVE status)', async () => {
      apiKeyRepository.findOne.mockResolvedValueOnce(null); // repo query includes status: ACTIVE
      const result = await service.verify('pk_revokedkey.somesecret');
      expect(result).toBeNull();
      expect(apiKeyRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: PartnerApiKeyStatus.ACTIVE,
          }),
        }),
      );
    });

    it('updates lastUsedAt on a successful verification', async () => {
      const { apiKey, keyId, secretHash } = await setupValidKey();
      const row = {
        keyId,
        secretHash,
        partnerId: '1',
        partner: { publicId: 'partner-public-id' },
        lastUsedAt: null,
      };
      apiKeyRepository.findOne.mockResolvedValueOnce(row);
      apiKeyRepository.save.mockResolvedValueOnce(row);

      await service.verify(apiKey);
      expect(row.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  describe('revoke', () => {
    it('throws when the key does not belong to the given partner', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(partner);
      apiKeyRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.revoke('partner-public-id', 'pk_notfound'),
      ).rejects.toThrow(NotFoundException);
    });

    it('marks a key REVOKED without deleting the row (audit trail preserved)', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(partner);
      const row = { keyId: 'pk_abc', status: PartnerApiKeyStatus.ACTIVE };
      apiKeyRepository.findOne.mockResolvedValueOnce(row);
      apiKeyRepository.save.mockResolvedValueOnce(row);

      const result = await service.revoke('partner-public-id', 'pk_abc');
      expect(result).toEqual({ status: 'revoked' });
      expect(row.status).toBe(PartnerApiKeyStatus.REVOKED);
    });
  });

  describe('list', () => {
    it('never includes secretHash or the raw key in the response', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(partner);
      apiKeyRepository.find.mockResolvedValueOnce([
        {
          keyId: 'pk_abc',
          secretHash: 'should-never-appear',
          label: 'Prod key',
          status: PartnerApiKeyStatus.ACTIVE,
          lastUsedAt: null,
          createdAt: new Date(),
        },
      ]);

      const result = await service.list('partner-public-id');
      expect(result[0]).not.toHaveProperty('secretHash');
      expect(JSON.stringify(result)).not.toContain('should-never-appear');
    });
  });
});
