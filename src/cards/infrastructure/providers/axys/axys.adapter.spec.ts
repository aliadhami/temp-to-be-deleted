import { randomUUID } from 'node:crypto';
import { CardCapability } from '../../../domain/card-capability.enum';
import { CardActivationIntent } from '../../../domain/card-issuance-intent.model';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { CardProviderUnsupportedOperationError } from '../../../domain/card-provider-unsupported-operation.error';
import { CardStatus } from '../../../domain/card-status.enum';
import { AxysAdapter } from './axys.adapter';
import { AxysHttpClient } from './axys-http-client.service';

describe('AxysAdapter', () => {
  /** Every test needs an adapter and most need no working transport at all. */
  const makeAdapter = (httpClient: Partial<AxysHttpClient> = {}): AxysAdapter =>
    new AxysAdapter(httpClient as AxysHttpClient);

  // Pinning the whole set, not just the two flags the capability split added:
  // this literal is what the split edited, so a neighbouring value dropped by
  // accident is exactly the regression worth catching. Axys is a live provider
  // and its behaviour must be identical on every path either side of the split.
  it('declares the full expected capability set', () => {
    expect([...makeAdapter().capabilities].sort()).toEqual(
      [
        CardCapability.ONBOARD_CARDHOLDER,
        CardCapability.CARDHOLDER_STATUS,
        CardCapability.ISSUE_VIRTUAL,
        CardCapability.ISSUE_PHYSICAL,
        CardCapability.ACTIVATE,
        CardCapability.SENSITIVE_REVEAL,
        CardCapability.DEPOSIT_ADDRESS,
        CardCapability.BALANCE_READ,
        CardCapability.BLOCK,
        CardCapability.PIN_MANAGEMENT,
        CardCapability.TRANSACTIONS_READ,
        CardCapability.CUSTOM_NAME_ON_CARD,
      ].sort(),
    );
  });

  describe('the lifecycle operations, which apply during the call', () => {
    const PROVIDER_CARD_ID = 'card_abc';

    const respondingWith = (data: Record<string, unknown>) => ({
      request: jest.fn().mockResolvedValue({
        status: 200,
        body: { success: true, data },
      }),
    });

    it('reports a block as applied, with the status the issuer answered', async () => {
      const httpClient = respondingWith({
        status: 'on_hold',
        operation: 'block',
        updated: true,
      });

      await expect(
        makeAdapter(httpClient as unknown as AxysHttpClient).updateCardStatus(
          PROVIDER_CARD_ID,
          { reference: randomUUID(), status: 'on_hold', reason: 'stolen' },
          {},
        ),
      ).resolves.toEqual({
        state: 'APPLIED',
        status: CardStatus.ON_HOLD,
        operation: 'block',
        updated: true,
      });
    });

    it('sends the status and reason it always did, and not the reference', async () => {
      // The reference belongs to an issuer with a result lookup to key on.
      // Axys has none, and sending an unrecognised field is a behaviour change
      // on a live provider.
      const httpClient = respondingWith({
        status: 'on_hold',
        operation: 'block',
        updated: true,
      });
      const idempotencyKey = 'status-abc-1';

      await makeAdapter(
        httpClient as unknown as AxysHttpClient,
      ).updateCardStatus(
        PROVIDER_CARD_ID,
        { reference: randomUUID(), status: 'on_hold', reason: 'stolen' },
        {},
        idempotencyKey,
      );

      expect(httpClient.request).toHaveBeenCalledWith(
        'PUT',
        `/cards/${PROVIDER_CARD_ID}/status`,
        { status: 'on_hold', reason: 'stolen' },
        idempotencyKey,
      );
    });

    it('omits the reason when none was given', async () => {
      const httpClient = respondingWith({
        status: 'active',
        operation: 'unblock',
        updated: true,
      });

      await makeAdapter(
        httpClient as unknown as AxysHttpClient,
      ).updateCardStatus(
        PROVIDER_CARD_ID,
        { reference: randomUUID(), status: 'active' },
        {},
      );

      expect(httpClient.request).toHaveBeenCalledWith(
        'PUT',
        `/cards/${PROVIDER_CARD_ID}/status`,
        { status: 'active' },
        undefined,
      );
    });

    it('carries the issuer’s idempotent replay through as applied but unchanged', async () => {
      const httpClient = respondingWith({
        status: 'on_hold',
        operation: 'block',
        updated: false,
      });

      await expect(
        makeAdapter(httpClient as unknown as AxysHttpClient).updateCardStatus(
          PROVIDER_CARD_ID,
          { reference: randomUUID(), status: 'on_hold', reason: 'stolen' },
          {},
        ),
      ).resolves.toMatchObject({ state: 'APPLIED', updated: false });
    });

    it('reports a PIN change as applied', async () => {
      const httpClient = respondingWith({
        status: 'active',
        operation: 'update_pin',
        updated: true,
      });

      await expect(
        makeAdapter(httpClient as unknown as AxysHttpClient).updateCardPin(
          PROVIDER_CARD_ID,
          'pin-change-1',
          '1111',
          '2222',
          {},
        ),
      ).resolves.toEqual({
        state: 'APPLIED',
        status: CardStatus.ACTIVE,
        operation: 'update_pin',
        updated: true,
      });
    });

    it('sends the PIN body it always did', async () => {
      const httpClient = respondingWith({
        status: 'active',
        operation: 'update_pin',
        updated: true,
      });

      await makeAdapter(httpClient as unknown as AxysHttpClient).updateCardPin(
        PROVIDER_CARD_ID,
        'pin-change-1',
        '1111',
        '2222',
        {},
        'idem-1',
      );

      expect(httpClient.request).toHaveBeenCalledWith(
        'PUT',
        `/cards/${PROVIDER_CARD_ID}/pin`,
        {
          pin_change_request_id: 'pin-change-1',
          old_pin: '1111',
          new_pin: '2222',
        },
        'idem-1',
      );
    });
  });

  describe('getCardTransactions', () => {
    const theirItem = (overrides: Record<string, unknown> = {}) => ({
      id: 'txn_abc',
      amount_minor: '1499',
      currency_code: 'USD',
      status: 'settled',
      category: 'authorization',
      merchant_name: 'Blue Bottle',
      merchant_amount_minor: '1499',
      merchant_currency: 'USD',
      created_at: '2026-07-08T12:00:00.000Z',
      settled_at: '2026-07-08T12:00:00.000Z',
      ...overrides,
    });

    const adapterReturning = (items: Record<string, unknown>[]) =>
      makeAdapter({
        request: jest.fn().mockResolvedValue({
          status: 200,
          body: {
            success: true,
            data: { card_id: 'card_1', items, next_cursor: null },
          },
        }),
      } as unknown as Partial<AxysHttpClient>);

    it('converts its minor units into the decimal strings the port publishes', async () => {
      // Axys names these fields for minor units and is the only issuer here
      // that publishes them; the port carries decimal strings in the currency's
      // own units, so this adapter is where the two meet.
      const result = await adapterReturning([theirItem()]).getCardTransactions(
        'card_1',
        {},
        {},
      );

      expect(result.items[0]).toMatchObject({
        amount: '14.99',
        merchantAmount: '14.99',
        currencyCode: 'USD',
      });
    });

    it('uses the currency’s own exponent rather than a constant', async () => {
      const result = await adapterReturning([
        theirItem({ amount_minor: '1499', currency_code: 'JPY' }),
        theirItem({
          id: 'txn_bhd',
          amount_minor: '1499',
          currency_code: 'BHD',
        }),
      ]).getCardTransactions('card_1', {}, {});

      // A constant of two would misstate the first by two orders of magnitude.
      expect(result.items[0]!.amount).toBe('1499');
      expect(result.items[1]!.amount).toBe('1.499');
    });

    it('converts the merchant figure in the merchant’s own currency', async () => {
      // A foreign purchase carries both currencies, and shifting the merchant
      // amount by the card currency's exponent misstates it wherever they
      // differ.
      const result = await adapterReturning([
        theirItem({
          amount_minor: '1499',
          currency_code: 'USD',
          merchant_amount_minor: '1499',
          merchant_currency: 'JPY',
        }),
      ]).getCardTransactions('card_1', {}, {});

      expect(result.items[0]).toMatchObject({
        amount: '14.99',
        merchantAmount: '1499',
        merchantCurrency: 'JPY',
      });
    });

    it('leaves a missing merchant amount null rather than converting nothing into zero', async () => {
      const result = await adapterReturning([
        theirItem({ merchant_amount_minor: null, merchant_currency: null }),
      ]).getCardTransactions('card_1', {}, {});

      expect(result.items[0]).toMatchObject({
        merchantAmount: null,
        merchantCurrency: null,
      });
    });

    it('publishes a figure that is not whole exactly as sent', async () => {
      // Minor units are whole by definition, so a value carrying a decimal
      // point is already in ordinary units and there is nothing to shift.
      // Refusing would take down a statement over one row; shifting it would
      // misstate the money.
      const result = await adapterReturning([
        theirItem({ amount_minor: '14.99' }),
      ]).getCardTransactions('card_1', {}, {});

      expect(result.items[0]!.amount).toBe('14.99');
    });

    it('omits the description this issuer does not publish', async () => {
      // Absent rather than undefined: an optional cannot be set to undefined
      // under `exactOptionalPropertyTypes`.
      const result = await adapterReturning([theirItem()]).getCardTransactions(
        'card_1',
        {},
        {},
      );

      expect(result.items[0]).not.toHaveProperty('description');
    });
  });

  describe('getCardOperationResult', () => {
    // A permanent refusal rather than an unbuilt method: Axys applies a block
    // during the call that asks for one, so nothing is left to report. The
    // undeclared capability refuses in practice; this is the backstop.
    it('does not declare OPERATION_RESULT while still declaring BLOCK', () => {
      // Asserted together: the two are different claims, and Axys freezes
      // cards perfectly well while having no second outcome.
      expect(
        makeAdapter().capabilities.has(CardCapability.OPERATION_RESULT),
      ).toBe(false);
      expect(makeAdapter().capabilities.has(CardCapability.BLOCK)).toBe(true);
    });

    it('rejects with the provider-neutral unsupported-operation error', async () => {
      await expect(
        makeAdapter().getCardOperationResult(),
      ).rejects.toBeInstanceOf(CardProviderUnsupportedOperationError);
    });

    it('names the provider and the port method on the error', async () => {
      await expect(
        makeAdapter().getCardOperationResult(),
      ).rejects.toMatchObject({
        providerKey: CardProviderKey.AXYS,
        operation: 'getCardOperationResult',
      });
    });

    it('returns a promise rather than throwing synchronously', () => {
      const returned = makeAdapter().getCardOperationResult();

      expect(returned).toBeInstanceOf(Promise);
      returned.catch(() => undefined);
    });

    it('never reaches the transport', async () => {
      const httpClient = { request: jest.fn() };

      await expect(
        makeAdapter(
          httpClient as unknown as Partial<AxysHttpClient>,
        ).getCardOperationResult(),
      ).rejects.toBeInstanceOf(CardProviderUnsupportedOperationError);

      expect(httpClient.request).not.toHaveBeenCalled();
    });
  });

  describe('listCardProducts', () => {
    // Axys has no product concept at all, so this is a permanent refusal
    // rather than an unbuilt method. The undeclared capability is what refuses
    // in practice; the rejection below is the backstop behind it.
    it('does not declare PRODUCT_CATALOGUE — Axys has no catalogue to list', () => {
      expect(
        makeAdapter().capabilities.has(CardCapability.PRODUCT_CATALOGUE),
      ).toBe(false);
    });

    it('rejects with the provider-neutral unsupported-operation error', async () => {
      // Deliberately the domain type rather than an adapter-local one: a
      // use-case must be able to recognise this without importing across the
      // layering boundary. Not AxysApiError either — that type means a call to
      // Axys was made and failed, and no call is made here.
      await expect(makeAdapter().listCardProducts()).rejects.toBeInstanceOf(
        CardProviderUnsupportedOperationError,
      );
    });

    it('names the provider and the port method on the error', async () => {
      // A log line carrying only the message has to identify which call
      // refused, so `operation` is the method name rather than a prose phrase.
      await expect(makeAdapter().listCardProducts()).rejects.toMatchObject({
        providerKey: CardProviderKey.AXYS,
        operation: 'listCardProducts',
      });
    });

    it('returns a promise rather than throwing synchronously', () => {
      // A method declared Promise<T> that throws synchronously escapes
      // .catch() and Promise.allSettled(). If it did, this call would blow up
      // here instead of yielding a promise.
      const returned = makeAdapter().listCardProducts();

      expect(returned).toBeInstanceOf(Promise);
      returned.catch(() => undefined);
    });

    it('never reaches the transport', async () => {
      const httpClient = { request: jest.fn() };

      await expect(
        makeAdapter(
          httpClient as unknown as Partial<AxysHttpClient>,
        ).listCardProducts(),
      ).rejects.toBeInstanceOf(CardProviderUnsupportedOperationError);

      expect(httpClient.request).not.toHaveBeenCalled();
    });
  });

  describe('getMerchantBalance', () => {
    // Its cards are funded by paying into an address, so no float exists here.
    it('does not declare MERCHANT_BALANCE_READ', () => {
      expect(
        makeAdapter().capabilities.has(CardCapability.MERCHANT_BALANCE_READ),
      ).toBe(false);
    });

    it('rejects with the provider-neutral unsupported-operation error', async () => {
      await expect(makeAdapter().getMerchantBalance()).rejects.toBeInstanceOf(
        CardProviderUnsupportedOperationError,
      );
    });

    it('names the provider and the port method on the error', async () => {
      await expect(makeAdapter().getMerchantBalance()).rejects.toMatchObject({
        providerKey: CardProviderKey.AXYS,
        operation: 'getMerchantBalance',
      });
    });

    it('returns a promise rather than throwing synchronously', () => {
      const returned = makeAdapter().getMerchantBalance();

      expect(returned).toBeInstanceOf(Promise);
      returned.catch(() => undefined);
    });

    it('never reaches the transport', async () => {
      const httpClient = { request: jest.fn() };

      await expect(
        makeAdapter(
          httpClient as unknown as Partial<AxysHttpClient>,
        ).getMerchantBalance(),
      ).rejects.toBeInstanceOf(CardProviderUnsupportedOperationError);

      expect(httpClient.request).not.toHaveBeenCalled();
    });
  });

  describe('requestCardDeposit', () => {
    // A different funding model rather than a missing feature: Axys cards are
    // funded by paying into the per-chain addresses it assigns, so nothing
    // initiates a deposit and there is no request to make. Same shape as the
    // catalogue refusal above.
    it('does not declare DEPOSIT — Axys cards are funded by paying into an address', () => {
      expect(makeAdapter().capabilities.has(CardCapability.DEPOSIT)).toBe(
        false,
      );
    });

    it('still declares DEPOSIT_ADDRESS, which is how its cards are funded', () => {
      // The absence above is a statement about *this* operation, not about
      // funding — asserted together so a later change cannot read the first as
      // "Axys cannot be funded".
      expect(
        makeAdapter().capabilities.has(CardCapability.DEPOSIT_ADDRESS),
      ).toBe(true);
    });

    it('rejects with the provider-neutral unsupported-operation error', async () => {
      await expect(makeAdapter().requestCardDeposit()).rejects.toBeInstanceOf(
        CardProviderUnsupportedOperationError,
      );
    });

    it('names the provider and the port method on the error', async () => {
      await expect(makeAdapter().requestCardDeposit()).rejects.toMatchObject({
        providerKey: CardProviderKey.AXYS,
        operation: 'requestCardDeposit',
      });
    });

    it('returns a promise rather than throwing synchronously', () => {
      const returned = makeAdapter().requestCardDeposit();

      expect(returned).toBeInstanceOf(Promise);
      returned.catch(() => undefined);
    });

    it('never reaches the transport', async () => {
      const httpClient = { request: jest.fn() };

      await expect(
        makeAdapter(
          httpClient as unknown as Partial<AxysHttpClient>,
        ).requestCardDeposit(),
      ).rejects.toBeInstanceOf(CardProviderUnsupportedOperationError);

      expect(httpClient.request).not.toHaveBeenCalled();
    });
  });

  describe('activateCard', () => {
    /**
     * The full set this issuer needs, as the request DTO used to guarantee it
     * would arrive.
     */
    const intent = {
      cardPublicId: '11111111-2222-4333-8444-555555555555',
      providerCardId: 'axys-card-1',
      pan: '4249040000004589',
      expiryMonth: 12,
      expiryYear: 2030,
      cvv: '123',
      pin: '1234',
    } satisfies CardActivationIntent;

    /** Their activation success, trimmed to the field the adapter maps. */
    const httpClientReturning = (status: string) => ({
      request: jest.fn().mockResolvedValue({
        status: 200,
        body: { success: true, data: { status }, requestId: 'req-1' },
      }),
    });

    it('sends the printed details and the chosen PIN, unchanged', async () => {
      const httpClient = httpClientReturning('active');

      await makeAdapter(
        httpClient as unknown as Partial<AxysHttpClient>,
      ).activateCard(intent, {});

      expect(httpClient.request).toHaveBeenNthCalledWith(
        1,
        'PUT',
        '/cards/axys-card-1/activate',
        expect.objectContaining({
          pan: '4249040000004589',
          expiry_month: 12,
          expiry_year: 2030,
          cvv: '123',
          pin: '1234',
        }),
        undefined,
      );
    });

    it.each(['pan', 'expiryMonth', 'expiryYear', 'cvv', 'pin'] as const)(
      'refuses an activation missing %s, naming that field',
      async (field) => {
        // Built by omission rather than by overriding with undefined: under
        // `exactOptionalPropertyTypes` those are different things, and absent
        // is what a request without the field actually produces.
        const withoutField: CardActivationIntent = { ...intent };
        delete withoutField[field];
        const httpClient = { request: jest.fn() };

        await expect(
          makeAdapter(
            httpClient as unknown as Partial<AxysHttpClient>,
          ).activateCard(withoutField, {}),
        ).rejects.toMatchObject({
          name: 'CardProviderIntentRejectedError',
          providerKey: CardProviderKey.AXYS,
          field,
        });

        // Refused before anything is sent, so a request that could never
        // succeed costs no round trip.
        expect(httpClient.request).not.toHaveBeenCalled();
      },
    );

    it('is unaffected by an activation document meant for another issuer', async () => {
      // A partner sending both is sending one issuer's shape to another's card.
      // The extra field is simply unread here rather than forwarded.
      const httpClient = httpClientReturning('active');

      await makeAdapter(
        httpClient as unknown as Partial<AxysHttpClient>,
      ).activateCard({ ...intent, activationDocument: 'aGVsbG8=' }, {});

      expect(httpClient.request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(httpClient.request.mock.calls)).not.toContain(
        'aGVsbG8=',
      );
    });
  });

  describe('readCallback and callbackAck', () => {
    // Axys answers when asked and posts nothing back, so neither method has
    // anything to do. The undeclared capability is what refuses in practice;
    // the rejections below are the backstop behind it.
    it('does not declare CALLBACK_EVENTS — Axys sends none', () => {
      expect(
        makeAdapter().capabilities.has(CardCapability.CALLBACK_EVENTS),
      ).toBe(false);
    });

    it('rejects a delivery with the provider-neutral unsupported-operation error', async () => {
      await expect(makeAdapter().readCallback()).rejects.toMatchObject({
        name: 'CardProviderUnsupportedOperationError',
        providerKey: CardProviderKey.AXYS,
        operation: 'readCallback',
      });
    });

    it('returns a promise rather than throwing synchronously', () => {
      const returned = makeAdapter().readCallback();

      expect(returned).toBeInstanceOf(Promise);
      returned.catch(() => undefined);
    });

    it('refuses to invent an acknowledgement', () => {
      // Synchronous, matching the port: a caller that got a fabricated ack
      // would be answering a caller that does not exist.
      expect(() => makeAdapter().callbackAck()).toThrow(
        CardProviderUnsupportedOperationError,
      );
    });
  });
});
