import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CredentialEncryptionService } from '../../shared/crypto/credential-encryption.service';
import { GatewayKey } from '../../payments/domain/gateway-key.enum';
import { CredentialEnvironment } from '../domain/credential-environment.enum';
import { PartnerStatus } from '../domain/partner-status.enum';
import { PartnerGatewayCredentialEntity } from '../persistence/partner-gateway-credential.entity';
import { PartnerEntity } from '../persistence/partner.entity';
import { PartnerManagementService } from './partner-management.service';

describe('PartnerManagementService', () => {
  let service: PartnerManagementService;
  let partnerRepository: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let credentialRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let encryptionService: { encrypt: jest.Mock; decrypt: jest.Mock };

  const savedPartner: Partial<PartnerEntity> = {
    id: '1',
    publicId: 'partner-public-id',
    name: 'Acme Exchange',
    status: PartnerStatus.ACTIVE,
    allowedGateways: ['MLT'],
    allowedCurrencies: ['AED'],
    allowedMethods: ['FIAT_CARD'],
    feePercent: null,
    feeFlat: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    partnerRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((input: unknown) => input),
      save: jest.fn(),
    };
    credentialRepository = {
      findOne: jest.fn(),
      create: jest.fn((input: unknown) => input),
      save: jest.fn(),
    };
    encryptionService = { encrypt: jest.fn(), decrypt: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PartnerManagementService,
        {
          provide: getRepositoryToken(PartnerEntity),
          useValue: partnerRepository,
        },
        {
          provide: getRepositoryToken(PartnerGatewayCredentialEntity),
          useValue: credentialRepository,
        },
        { provide: CredentialEncryptionService, useValue: encryptionService },
      ],
    }).compile();

    service = module.get(PartnerManagementService);
  });

  describe('create', () => {
    it('creates an active partner with the given fields', async () => {
      partnerRepository.save.mockResolvedValueOnce(savedPartner);

      const result = await service.create({
        name: 'Acme Exchange',
        allowedGateways: ['MLT'],
        allowedCurrencies: ['AED'],
        allowedMethods: ['FIAT_CARD'],
      });

      expect(partnerRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: PartnerStatus.ACTIVE }),
      );
      expect(result.publicId).toBe('partner-public-id');
    });
  });

  describe('getByPublicId', () => {
    it('throws NotFoundException for an unknown partner', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.getByPublicId('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('only overwrites fields explicitly provided', async () => {
      partnerRepository.findOne.mockResolvedValueOnce({ ...savedPartner });
      partnerRepository.save.mockImplementationOnce((entity) => entity);

      const result = await service.update('partner-public-id', {
        feePercent: '3.000',
      });

      expect(result.name).toBe('Acme Exchange'); // unchanged
      expect(result.feePercent).toBe('3.000'); // updated
    });
  });

  describe('setCredentials', () => {
    it('throws when the partner does not exist', async () => {
      partnerRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.setCredentials(
          'missing',
          GatewayKey.MLT,
          CredentialEnvironment.UAT,
          { merchantId: 'X' },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('encrypts and stores new credentials, returning no plaintext', async () => {
      partnerRepository.findOne.mockResolvedValueOnce({ ...savedPartner });
      credentialRepository.findOne.mockResolvedValueOnce(null);
      encryptionService.encrypt.mockReturnValueOnce(
        Buffer.from('encrypted-blob'),
      );

      const result = await service.setCredentials(
        'partner-public-id',
        GatewayKey.MLT,
        CredentialEnvironment.UAT,
        { merchantId: 'ABC123', secretKey: 'shh' },
      );

      expect(encryptionService.encrypt).toHaveBeenCalledWith(
        JSON.stringify({ merchantId: 'ABC123', secretKey: 'shh' }),
      );
      expect(result).toEqual({ status: 'stored' });
    });

    it('updates existing credentials in place rather than duplicating a row', async () => {
      partnerRepository.findOne.mockResolvedValueOnce({ ...savedPartner });
      const existingRow = { id: '5', credentialsEncrypted: Buffer.from('old') };
      credentialRepository.findOne.mockResolvedValueOnce(existingRow);
      encryptionService.encrypt.mockReturnValueOnce(
        Buffer.from('new-encrypted'),
      );

      await service.setCredentials(
        'partner-public-id',
        GatewayKey.MLT,
        CredentialEnvironment.UAT,
        { merchantId: 'NEW' },
      );

      expect(credentialRepository.create).not.toHaveBeenCalled();
      expect(credentialRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: '5' }),
      );
    });
  });
});
