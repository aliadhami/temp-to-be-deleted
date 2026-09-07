import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderConflictError } from '../domain/card-provider-conflict.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardProviderUnsupportedOperationError } from '../domain/card-provider-unsupported-operation.error';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEventEntity } from '../infrastructure/persistence/cardholder-event.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentResolver } from './cardholder-enrolment.resolver';
import { SubmitKycUseCase } from './submit-kyc.usecase';

describe('SubmitKycUseCase', () => {
  let useCase: SubmitKycUseCase;
  let cardholderRepository: { findOne: jest.Mock };
  let enrolmentRepository: { save: jest.Mock };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let enrolmentResolver: { require: jest.Mock };

  const adapter = {
    capabilities: new Set([CardCapability.ONBOARD_CARDHOLDER]),
    submitKyc: jest.fn(),
  };

  beforeEach(async () => {
    cardholderRepository = { findOne: jest.fn() };
    enrolmentRepository = { save: jest.fn((x: unknown) => x) };
    eventRepository = { create: jest.fn((x: unknown) => x), save: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };
    enrolmentResolver = { require: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubmitKycUseCase,
        {
          provide: getRepositoryToken(CardholderEntity),
          useValue: cardholderRepository,
        },
        {
          provide: getRepositoryToken(CardholderEnrolmentEntity),
          useValue: enrolmentRepository,
        },
        {
          provide: getRepositoryToken(CardholderEventEntity),
          useValue: eventRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        {
          provide: CardholderEnrolmentResolver,
          useValue: enrolmentResolver,
        },
      ],
    }).compile();

    useCase = module.get(SubmitKycUseCase);
    jest.clearAllMocks();
    // `adapter` is module-scope and outlives each test, and `clearAllMocks`
    // clears recorded calls but *not* queued one-shot implementations.
    adapter.submitKyc.mockReset();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    cardholderRepository.findOne.mockResolvedValue({
      id: '1',
      publicId: 'ch-1',
    });
    enrolmentResolver.require.mockResolvedValue({
      id: '11',
      cardholderId: '1',
      providerKey: CardProviderKey.AXYS,
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });
  });

  it('throws ForbiddenException when the provider cannot onboard cardholders', async () => {
    const stub = { capabilities: new Set(), submitKyc: jest.fn() };
    cardIssuerRegistry.resolve.mockReturnValueOnce(stub);

    await expect(
      useCase.execute('partner-1', 'ch-1', CardProviderKey.AXYS),
    ).rejects.toThrow(ForbiddenException);
    expect(stub.submitKyc).not.toHaveBeenCalled();
  });

  it('submits KYC when the capability is declared', async () => {
    adapter.submitKyc.mockResolvedValueOnce({
      status: CardholderStatus.UNDER_REVIEW,
    });

    const result = await useCase.execute(
      'partner-1',
      'ch-1',
      CardProviderKey.AXYS,
    );

    expect(adapter.submitKyc).toHaveBeenCalled();
    expect(result.status).toBe(CardholderStatus.UNDER_REVIEW);
  });

  describe('an issuer with no separate KYC step', () => {
    // The capability gate above cannot refuse this one. KYC submission carries
    // no flag of its own and rides the onboarding one, so an issuer that
    // onboards but keeps identity material on the card application declares the
    // flag, passes the gate, and still cannot answer.
    const unsupported = () =>
      new CardProviderUnsupportedOperationError(
        CardProviderKey.HYPERCARD,
        'submitKyc',
        'identity material is carried by the card application itself',
      );

    it('answers with a conflict rather than a server fault', async () => {
      adapter.submitKyc.mockRejectedValueOnce(unsupported());

      await expect(
        useCase.execute('partner-1', 'ch-1', CardProviderKey.AXYS),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("surfaces the issuer's reason and not the port method name", async () => {
      // The reason belongs to the adapter, which is the only layer that knows
      // why its provider has no such step. But only `reason` reaches the body:
      // the error's `message` also names the port method, which is our
      // vocabulary and means nothing to a partner.
      const thrown = unsupported();
      adapter.submitKyc.mockRejectedValueOnce(thrown);

      const error = await useCase
        .execute('partner-1', 'ch-1', CardProviderKey.AXYS)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(thrown.reason);
      expect((error as ConflictException).message).not.toContain('submitKyc');
      // The full message still reaches a log line, via the cause.
      expect((error as ConflictException).cause).toBe(thrown);
    });

    it('writes nothing', async () => {
      // The refusal arrives from the provider call, which sits ahead of both
      // writes — so a refused submission must not leave a status change or an
      // event behind.
      adapter.submitKyc.mockRejectedValueOnce(unsupported());

      await expect(
        useCase.execute('partner-1', 'ch-1', CardProviderKey.AXYS),
      ).rejects.toThrow();
      expect(enrolmentRepository.save).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });

    it('leaves every other provider failure alone', async () => {
      // Guards the catch from widening into "any failure is a 409". A call that
      // was made and failed is not the same as an operation that does not
      // exist, and flattening the two would report a provider outage as the
      // partner's mistake.
      const failure = new Error('HyperCard submit KYC failed');
      adapter.submitKyc.mockRejectedValueOnce(failure);

      await expect(
        useCase.execute('partner-1', 'ch-1', CardProviderKey.AXYS),
      ).rejects.toBe(failure);
    });
  });

  describe('an issuer that has the step and refused this cardholder', () => {
    // The other conflict, and the one that predates HyperCard entirely: a
    // provider that does submit KYC, answering that this cardholder's state
    // does not permit it. Axys signals it with HTTP 409, which its response
    // util turns into this type.
    const refused = () =>
      new CardProviderConflictError(
        CardProviderKey.AXYS,
        'KYC_ALREADY_SUBMITTED',
        'kyc already submitted',
      );

    it('answers with a conflict rather than a server fault', async () => {
      // This was a 500 for a routine state refusal on the live provider. Every
      // other use-case in this module that calls a provider maps this type;
      // this one did not.
      adapter.submitKyc.mockRejectedValueOnce(refused());

      await expect(
        useCase.execute('partner-1', 'ch-1', CardProviderKey.AXYS),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("does not echo the provider's own message", async () => {
      // Unlike the reason on the unsupported-operation error, which an adapter
      // authors, this text arrives from a remote system in a shape nobody here
      // controls — so it goes to the cause, not the body.
      const thrown = refused();
      adapter.submitKyc.mockRejectedValueOnce(thrown);

      const error = await useCase
        .execute('partner-1', 'ch-1', CardProviderKey.AXYS)
        .catch((caught: unknown) => caught);

      expect((error as ConflictException).message).not.toContain(
        'kyc already submitted',
      );
      expect((error as ConflictException).cause).toBe(thrown);
    });

    it('writes nothing', async () => {
      adapter.submitKyc.mockRejectedValueOnce(refused());

      await expect(
        useCase.execute('partner-1', 'ch-1', CardProviderKey.AXYS),
      ).rejects.toThrow();
      expect(enrolmentRepository.save).not.toHaveBeenCalled();
      expect(eventRepository.save).not.toHaveBeenCalled();
    });
  });
});
