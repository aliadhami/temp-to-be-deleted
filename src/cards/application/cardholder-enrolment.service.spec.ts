import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { CardCapability } from '../domain/card-capability.enum';
import { CardProviderIntentRejectedError } from '../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderIntent } from '../domain/cardholder-intent.model';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEventEntity } from '../infrastructure/persistence/cardholder-event.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { CardholderEnrolmentService } from './cardholder-enrolment.service';

const duplicateEntry = () => {
  const error = new QueryFailedError('INSERT', [], new Error('dup'));
  Object.assign(error, {
    code: 'ER_DUP_ENTRY',
    sqlMessage:
      "Duplicate entry '7-AXYS' for key 'uq_cardholder_enrolment_provider'",
  });
  return error;
};

describe('CardholderEnrolmentService', () => {
  let service: CardholderEnrolmentService;
  let enrolmentRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let eventRepository: { create: jest.Mock; save: jest.Mock };
  let cardIssuerRegistry: { resolve: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  const adapter = {
    capabilities: new Set([CardCapability.ONBOARD_CARDHOLDER]),
    onboardCardholder: jest.fn(),
  };

  const cardholder = {
    id: '7',
    publicId: 'ch-1',
    partnerId: 'partner-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phone: '+441234567890',
    dateOfBirth: '1815-12-10',
    residentialAddress: {
      addressLine1: '1 Main St',
      city: 'London',
      country: 'GB',
    },
    identityProvenance: {
      nationality: 'British',
      placeOfBirth: 'GBR',
      gender: 1 as const,
      callingCode: '44',
      countryCallingCode: 'GB',
      cellNumber: '1234567890',
    },
    userIp: null,
  } as unknown as CardholderEntity;

  const partner = {
    id: 'partner-1',
    allowedGateways: [CardProviderKey.AXYS, CardProviderKey.HYPERCARD],
  } as unknown as PartnerEntity;

  const enrol = (providerKey = CardProviderKey.AXYS) =>
    service.enrol(cardholder, partner, providerKey);

  beforeEach(async () => {
    enrolmentRepository = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => ({ id: '11', ...(x as object) })),
      findOne: jest.fn().mockResolvedValue(null),
    };
    eventRepository = { create: jest.fn((x: unknown) => x), save: jest.fn() };
    cardIssuerRegistry = { resolve: jest.fn(() => adapter) };
    // Runs the callback against a manager whose repository is the mock above,
    // so the claim is exercised rather than stubbed out. The row lock itself
    // is what only the e2e spec can prove.
    dataSource = {
      transaction: jest.fn((run: (manager: EntityManager) => unknown) =>
        run({
          getRepository: () => enrolmentRepository,
        } as unknown as EntityManager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CardholderEnrolmentService,
        {
          provide: getRepositoryToken(CardholderEnrolmentEntity),
          useValue: enrolmentRepository,
        },
        {
          provide: getRepositoryToken(CardholderEventEntity),
          useValue: eventRepository,
        },
        { provide: CardIssuerRegistry, useValue: cardIssuerRegistry },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(CardholderEnrolmentService);
    jest.clearAllMocks();
    cardIssuerRegistry.resolve.mockReturnValue(adapter);
    enrolmentRepository.findOne.mockResolvedValue(null);
  });

  it('refuses an issuer the partner is not permitted to use', async () => {
    await expect(
      service.enrol(
        cardholder,
        {
          ...partner,
          allowedGateways: [CardProviderKey.AXYS],
        } as PartnerEntity,
        CardProviderKey.HYPERCARD,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(enrolmentRepository.save).not.toHaveBeenCalled();
  });

  it('writes no enrolment row when the capability is missing', async () => {
    // The gate sits above the create/save because this is persistence-first: a
    // refusal below it would leave an orphaned DRAFT enrolment on every attempt.
    const stub = { capabilities: new Set(), onboardCardholder: jest.fn() };
    cardIssuerRegistry.resolve.mockReturnValueOnce(stub);

    await expect(enrol()).rejects.toThrow(ForbiddenException);

    expect(enrolmentRepository.create).not.toHaveBeenCalled();
    expect(enrolmentRepository.save).not.toHaveBeenCalled();
    expect(stub.onboardCardholder).not.toHaveBeenCalled();
  });

  it('persists and calls the provider when the capability is declared', async () => {
    adapter.onboardCardholder.mockResolvedValueOnce({
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });

    await enrol();

    expect(enrolmentRepository.save).toHaveBeenCalled();
    expect(adapter.onboardCardholder).toHaveBeenCalled();
  });

  it('sends the cardholder public id, never the enrolment', async () => {
    // An issuer that mints no identifier derives one from this, so a person's
    // reference must not change when they are put to a second issuer.
    adapter.onboardCardholder.mockResolvedValueOnce({
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });

    await enrol();

    const [intent] = adapter.onboardCardholder.mock.calls[0] as [
      CardholderIntent,
    ];
    expect(intent.publicId).toBe('ch-1');
  });

  it('passes the end user IP to the provider when the partner sent one', async () => {
    adapter.onboardCardholder.mockResolvedValueOnce({
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });

    await service.enrol(
      { ...cardholder, userIp: '203.0.113.42' } as CardholderEntity,
      partner,
      CardProviderKey.AXYS,
    );

    expect(adapter.onboardCardholder).toHaveBeenCalledWith(
      expect.objectContaining({ userIp: '203.0.113.42' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('omits the IP key entirely when the partner sent none', async () => {
    // Not `userIp: undefined`: `exactOptionalPropertyTypes` forbids setting an
    // optional field to undefined, and an adapter reading the key would see a
    // present-but-empty value rather than an absent one.
    adapter.onboardCardholder.mockResolvedValueOnce({
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });

    await enrol();

    // Read back through a typed cast rather than `expect.anything()`, which is
    // an `any` and trips no-unsafe-assignment.
    const [intent] = adapter.onboardCardholder.mock.calls[0] as [
      CardholderIntent,
    ];

    expect(intent).not.toHaveProperty('userIp');
  });

  describe('when the person already holds an enrolment with that issuer', () => {
    /** The insert collides, which is how the service learns a row is there. */
    const alreadyThere = (status: CardholderStatus, extra = {}) => {
      enrolmentRepository.save.mockRejectedValueOnce(duplicateEntry());
      enrolmentRepository.findOne.mockResolvedValueOnce({
        id: '11',
        status,
        ...extra,
      });
    };

    it('refuses a second attempt at one the issuer has answered', async () => {
      alreadyThere(CardholderStatus.APPROVED);

      await expect(enrol()).rejects.toThrow(ConflictException);
      expect(adapter.onboardCardholder).not.toHaveBeenCalled();
    });

    it('refuses one the issuer declined, rather than asking again', async () => {
      alreadyThere(CardholderStatus.COMPLIANCE_DECLINE);

      await expect(enrol()).rejects.toThrow(ConflictException);
      expect(adapter.onboardCardholder).not.toHaveBeenCalled();
    });

    it('refuses one whose attempt is still in flight', async () => {
      // `DRAFT` means an attempt was committed and its outcome is not yet
      // known. Writing over it would ask the issuer a second time about a
      // person it may already hold.
      alreadyThere(CardholderStatus.DRAFT);

      await expect(enrol()).rejects.toThrow(ConflictException);
      expect(adapter.onboardCardholder).not.toHaveBeenCalled();
    });

    it('re-attempts one that never reached the issuer', async () => {
      alreadyThere(CardholderStatus.ERROR, {
        message: 'Onboarding could not be completed',
      });
      adapter.onboardCardholder.mockResolvedValueOnce({
        providerCardholderId: 'axys-1',
        status: CardholderStatus.PENDING,
      });

      await enrol();

      expect(adapter.onboardCardholder).toHaveBeenCalled();
      // The stale failure is cleared, so a partner reading the row is not told
      // about an attempt that has since been superseded.
      expect(enrolmentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ message: null }),
      );
    });

    it('records the transition it actually made on a re-attempt', async () => {
      alreadyThere(CardholderStatus.ERROR);
      adapter.onboardCardholder.mockResolvedValueOnce({
        providerCardholderId: 'axys-1',
        status: CardholderStatus.PENDING,
      });

      await enrol();

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatus: CardholderStatus.ERROR,
          toStatus: CardholderStatus.PENDING,
        }),
      );
    });
  });

  it('answers a lost insert race from the constraint rather than a 500', async () => {
    // Two concurrent first attempts both insert; the unique index decides, and
    // the loser reads the winner's in-flight row rather than surfacing an
    // unhandled write failure.
    enrolmentRepository.save.mockRejectedValueOnce(duplicateEntry());
    enrolmentRepository.findOne.mockResolvedValueOnce({
      id: '11',
      status: CardholderStatus.DRAFT,
    });

    await expect(enrol()).rejects.toThrow(ConflictException);
  });

  it('takes no lock on the ordinary path', async () => {
    // A locking read for a row that does not exist gap-locks the unique index,
    // which blocks every other cardholder's first enrolment behind it.
    adapter.onboardCardholder.mockResolvedValueOnce({
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });

    await enrol();

    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(enrolmentRepository.findOne).not.toHaveBeenCalled();
  });

  it('locks the row once the insert has proven one exists', async () => {
    // Without it two re-attempts against an existing row both read the same
    // pre-attempt status and both proceed.
    enrolmentRepository.save.mockRejectedValueOnce(duplicateEntry());
    enrolmentRepository.findOne.mockResolvedValueOnce({
      id: '11',
      status: CardholderStatus.ERROR,
    });
    adapter.onboardCardholder.mockResolvedValueOnce({
      providerCardholderId: 'axys-1',
      status: CardholderStatus.PENDING,
    });

    await enrol();

    expect(enrolmentRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('does not hold the lock across the provider call', async () => {
    // A network call inside the transaction would keep the row locked for the
    // length of an issuer's response, and time out under any real load.
    let openWhenCalled = true;
    enrolmentRepository.save.mockRejectedValueOnce(duplicateEntry());
    enrolmentRepository.findOne.mockResolvedValueOnce({
      id: '11',
      status: CardholderStatus.ERROR,
    });
    dataSource.transaction.mockImplementation(
      async (run: (manager: EntityManager) => Promise<unknown>) => {
        const claimed = await run({
          getRepository: () => enrolmentRepository,
        } as unknown as EntityManager);
        openWhenCalled = false;
        return claimed;
      },
    );
    adapter.onboardCardholder.mockImplementationOnce(() => {
      expect(openWhenCalled).toBe(false);
      return Promise.resolve({
        providerCardholderId: 'axys-1',
        status: CardholderStatus.PENDING,
      });
    });

    await enrol();

    expect(adapter.onboardCardholder).toHaveBeenCalled();
  });

  describe('when the provider call fails', () => {
    it('leaves the row in ERROR carrying the reason rather than stranded in DRAFT', async () => {
      // Persistence-first commits the DRAFT row before the provider is
      // reached, and nothing sweeps a DRAFT enrolment — the reconcile pass
      // reads PENDING and UNDER_REVIEW. Without this the row is invisible and
      // says nothing about why it never progressed.
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('provider unreachable'),
      );

      await expect(enrol()).rejects.toThrow('provider unreachable');

      expect(enrolmentRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: CardholderStatus.ERROR }),
      );
    });

    it('keeps the provider reason out of the partner-facing column', async () => {
      // `cardholder_enrolment.message` is projected into the onboarding and
      // lookup responses, so a transport message would publish internal
      // hostnames and ports to whoever asks.
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 10.0.2.15:8443'),
      );

      await expect(enrol()).rejects.toThrow();

      const [row] = enrolmentRepository.save.mock.calls.at(-1) as [
        CardholderEnrolmentEntity,
      ];
      expect(row.message).not.toContain('10.0.2.15');
      expect(row.message).toContain('card provider');
    });

    it('keeps the real reason on the event, which is internal', async () => {
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 10.0.2.15:8443'),
      );

      await expect(enrol()).rejects.toThrow();

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: 'connect ECONNREFUSED 10.0.2.15:8443',
        }),
      );
    });

    it('publishes a data refusal, which was written for the partner', async () => {
      adapter.onboardCardholder.mockRejectedValueOnce(
        new CardProviderIntentRejectedError(
          CardProviderKey.HYPERCARD,
          'lastName',
          'this issuer accepts only letters and spaces in a name',
        ),
      );

      await expect(enrol()).rejects.toThrow();

      expect(enrolmentRepository.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('lastName') as unknown as string,
        }),
      );
    });

    it('rethrows the provider error when the bookkeeping write also fails', async () => {
      // The two writes run in exactly the conditions that break writes. If the
      // repository's error escaped instead, the caller would be told about the
      // symptom and never about the cause.
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('provider unreachable'),
      );
      // The first save is the DRAFT write and must succeed — it is the second,
      // inside the failure handler, that has to blow up.
      enrolmentRepository.save
        .mockImplementationOnce((x: unknown) => ({
          id: '11',
          ...(x as object),
        }))
        .mockRejectedValueOnce(new Error('connection lost'));

      await expect(enrol()).rejects.toThrow('provider unreachable');
    });

    it('records the transition', async () => {
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('provider unreachable'),
      );

      await expect(enrol()).rejects.toThrow();

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatus: CardholderStatus.DRAFT,
          toStatus: CardholderStatus.ERROR,
        }),
      );
      expect(eventRepository.save).toHaveBeenCalled();
    });

    it('turns a refusal of the partner data into a 400 naming the field', async () => {
      // A provider declining a value the partner supplied is theirs to fix. As
      // a bare Error it would reach them as a 500 naming nothing.
      adapter.onboardCardholder.mockRejectedValueOnce(
        new CardProviderIntentRejectedError(
          CardProviderKey.HYPERCARD,
          'lastName',
          'this issuer accepts only letters and spaces in a name',
        ),
      );

      // Caught once and asserted twice, rather than two `rejects` assertions:
      // a second call would find the one-shot mock exhausted and fail for an
      // unrelated reason.
      const error: unknown = await enrol().catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain('lastName');
    });

    it('does not truncate a short reason', async () => {
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('a'.repeat(80)),
      );

      await expect(enrol()).rejects.toThrow();

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'a'.repeat(80) }),
      );
    });

    it('truncates a reason too long for the event column', async () => {
      // Both columns are varchar(255), and an over-long message would
      // otherwise fail the very write that records the failure.
      adapter.onboardCardholder.mockRejectedValueOnce(
        new Error('a'.repeat(400)),
      );

      await expect(enrol()).rejects.toThrow();

      expect(eventRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ detail: 'a'.repeat(255) }),
      );
    });

    it('truncates a refusal too long for the partner column', async () => {
      adapter.onboardCardholder.mockRejectedValueOnce(
        new CardProviderIntentRejectedError(
          CardProviderKey.HYPERCARD,
          'lastName',
          'x'.repeat(400),
        ),
      );

      await expect(enrol()).rejects.toThrow();

      const [row] = enrolmentRepository.save.mock.calls.at(-1) as [
        CardholderEnrolmentEntity,
      ];
      expect(row.message).toHaveLength(255);
    });
  });
});
