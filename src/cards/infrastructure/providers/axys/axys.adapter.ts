import { Injectable, Logger } from '@nestjs/common';
import { CardCapability } from '../../../domain/card-capability.enum';
import { CardProviderCredentials } from '../../../domain/card-provider-credentials.model';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import {
  ActivateCardResult,
  CardApplicationOutcome,
  CardBalanceResult,
  CardCallbackReading,
  CardDepositOutcome,
  CardDepositRequestResult,
  CardholderStatusResult,
  CardIssuerPort,
  CardLifecycleOperationResult,
  CardOperationOutcome,
  CardFundingQuoteResult,
  CardProductListing,
  CardTransactionsResult,
  DepositAddress,
  IssueCardResult,
  KycSubmissionResult,
  ListCardTransactionsParams,
  MerchantBalanceResult,
  OnboardCardholderResult,
} from '../../../domain/card-issuer.port';
import {
  CardActivationIntent,
  CardIssuanceIntent,
} from '../../../domain/card-issuance-intent.model';
import { CardLifecycleOperationIntent } from '../../../domain/card-lifecycle-operation-intent.model';
import { CardholderIntent } from '../../../domain/cardholder-intent.model';
import { AxysHttpClient } from './axys-http-client.service';
import { axysMinorToDecimal } from './axys-currency-exponent';
import { unwrapAxysData } from './axys-response.util';
import {
  mapAxysCardholderStatus,
  mapAxysCardStatus,
} from './axys-status.mapper';
import {
  AxysAccountData,
  AxysActivateData,
  AxysCardData,
  AxysCardDetailData,
  AxysCardLifecycleData,
  AxysDepositAddressData,
  AxysEnvelope,
  AxysSensitiveCardData,
  AxysTransactionsData,
} from './axys.types';
import { SensitiveCardDetails } from '../../../domain/sensitive-card-details';
import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import { CardProviderUnsupportedOperationError } from '../../../domain/card-provider-unsupported-operation.error';

@Injectable()
export class AxysAdapter implements CardIssuerPort {
  readonly key = CardProviderKey.AXYS;
  readonly capabilities = new Set<CardCapability>([
    CardCapability.ONBOARD_CARDHOLDER,
    // It holds an account per cardholder and reports that account's own status.
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
    // Its card-creation request carries `name_on_card`, so the caller really
    // does choose what is printed and the field has to be supplied.
    CardCapability.CUSTOM_NAME_ON_CARD,
  ]);

  private readonly logger = new Logger(AxysAdapter.name);

  constructor(private readonly httpClient: AxysHttpClient) {}

  async onboardCardholder(
    intent: CardholderIntent,
    _credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<OnboardCardholderResult> {
    const body = {
      first_name: intent.firstName,
      last_name: intent.lastName,
      email: intent.email,
      phone: intent.phone,
      date_of_birth: intent.dateOfBirth,
      residential_address: {
        adr_line1: intent.residentialAddress.addressLine1,
        city: intent.residentialAddress.city,
        state: intent.residentialAddress.state ?? '',
        country: intent.residentialAddress.country,
        zip_code: intent.residentialAddress.zipCode ?? '',
      },
      identity_provenance: {
        nationality: intent.identityProvenance.nationality,
        place_of_birth: intent.identityProvenance.placeOfBirth,
        gender: intent.identityProvenance.gender,
        calling_code: intent.identityProvenance.callingCode,
        country_calling_code: intent.identityProvenance.countryCallingCode,
        cell_num: intent.identityProvenance.cellNumber,
      },
    };

    const response = await this.httpClient.request<
      AxysEnvelope<AxysAccountData>
    >('POST', '/accounts', body, idempotencyKey);
    const data = unwrapAxysData(
      'account creation',
      response.status,
      response.body,
    );

    return {
      providerCardholderId: data.id,
      status: mapAxysCardholderStatus(data.status),
      ...(data.kyc_url && { kycUrl: data.kyc_url }),
    };
  }

  async submitKyc(
    providerCardholderId: string,
    _credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<KycSubmissionResult> {
    const response = await this.httpClient.request<
      AxysEnvelope<AxysAccountData>
    >(
      'PUT',
      `/accounts/${providerCardholderId}/kyc-submit`,
      undefined,
      idempotencyKey,
    );
    const data = unwrapAxysData(
      'KYC submission',
      response.status,
      response.body,
    );

    return {
      status: mapAxysCardholderStatus(data.status),
      ...(data.kyc_url && { kycUrl: data.kyc_url }),
    };
  }

  async queryCardholderStatus(
    providerCardholderId: string,
    _credentials: CardProviderCredentials,
  ): Promise<CardholderStatusResult> {
    const response = await this.httpClient.request<
      AxysEnvelope<AxysAccountData>
    >('GET', `/accounts/${providerCardholderId}`);
    const data = unwrapAxysData(
      'account status query',
      response.status,
      response.body,
    );

    return { status: mapAxysCardholderStatus(data.status) };
  }

  async issueCard(
    providerCardholderId: string,
    intent: CardIssuanceIntent,
    _credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<IssueCardResult> {
    const body = {
      card_type: intent.cardType.toLowerCase(),
      name_on_card: intent.nameOnCard,
      //currency_code: intent.currency, // Axys updated document and removed currency_code from the request body, so we will not send it anymore
    };

    const response = await this.httpClient.request<AxysEnvelope<AxysCardData>>(
      'POST',
      `/accounts/${providerCardholderId}/cards`,
      body,
      idempotencyKey,
    );
    const data = unwrapAxysData(
      'card issuance',
      response.status,
      response.body,
    );

    return {
      providerCardId: data.id,
      status: mapAxysCardStatus(data.status),
      maskedPan: data.masked_pan,
    };
  }

  /**
   * Activation here is a cardholder confirming the card in their hand: Axys
   * takes the printed number, expiry and security code, plus the PIN they have
   * chosen. All five are checked before anything is sent, and that check is
   * not belt-and-braces.
   */
  async activateCard(
    intent: CardActivationIntent,
    _credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<ActivateCardResult> {
    const body = {
      activation_request_id: `activation-${intent.cardPublicId}`,
      pan: this.requireActivationField(intent.pan, 'pan'),
      expiry_month: this.requireActivationField(
        intent.expiryMonth,
        'expiryMonth',
      ),
      expiry_year: this.requireActivationField(intent.expiryYear, 'expiryYear'),
      cvv: this.requireActivationField(intent.cvv, 'cvv'),
      pin: this.requireActivationField(intent.pin, 'pin'),
    };

    const response = await this.httpClient.request<
      AxysEnvelope<AxysActivateData>
    >('PUT', `/cards/${intent.providerCardId}/activate`, body, idempotencyKey);
    const data = unwrapAxysData(
      'card activation',
      response.status,
      response.body,
    );

    return { status: mapAxysCardStatus(data.status) };
  }

  /** The activation fields this issuer cannot do without, refused by name. */
  private requireActivationField<T>(value: T | undefined, field: string): T {
    if (value === undefined) {
      throw new CardProviderIntentRejectedError(
        this.key,
        field,
        'this issuer activates a card the cardholder is holding, so it needs the details printed on it and the PIN they have chosen',
      );
    }

    return value;
  }

  async revealSensitiveCardDetails(
    providerCardId: string,
    _credentials: CardProviderCredentials,
  ): Promise<SensitiveCardDetails> {
    const response = await this.httpClient.request<
      AxysEnvelope<AxysSensitiveCardData>
    >('GET', `/cards/${providerCardId}/sensitive`);
    const data = unwrapAxysData(
      'sensitive card detail reveal',
      response.status,
      response.body,
    );

    // The full set, minus the full number: Axys returns a masked PAN and no
    // unmasked one, so `pan` is omitted rather than filled from `masked_pan`.
    // Under `exactOptionalPropertyTypes` an absent optional cannot be set to
    // undefined to say the same thing.
    return new SensitiveCardDetails({
      kind: 'FULL',
      maskedPan: data.masked_pan,
      cvv: data.cvv,
      expiryMonth: data.expiry_month,
      expiryYear: data.expiry_year,
    });
  }

  async getDepositAddresses(
    providerCardId: string,
    _credentials: CardProviderCredentials,
  ): Promise<DepositAddress[]> {
    const response = await this.httpClient.request<
      AxysEnvelope<AxysDepositAddressData>
    >('GET', `/cards/${providerCardId}/deposit-address`);
    const data = unwrapAxysData(
      'deposit address retrieval',
      response.status,
      response.body,
    );

    return data.deposit_addresses.map((entry) => ({
      chain: entry.chain,
      address: entry.address,
    }));
  }

  async getCardBalance(
    providerCardId: string,
    _credentials: CardProviderCredentials,
  ): Promise<CardBalanceResult | null> {
    const response = await this.httpClient.request<
      AxysEnvelope<AxysCardDetailData>
    >('GET', `/cards/${providerCardId}`);
    const data = unwrapAxysData(
      'card balance query',
      response.status,
      response.body,
    );

    if (!data.balance) return null;

    return {
      available: data.balance.available,
      ledger: data.balance.ledger,
      currencyCode: data.balance.currency_code,
      observedAt: data.balance.observed_at,
    };
  }

  async updateCardStatus(
    providerCardId: string,
    intent: CardLifecycleOperationIntent,
    _credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<CardLifecycleOperationResult> {
    const body: Record<string, unknown> = { status: intent.status };
    if (intent.reason) body.reason = intent.reason;
    // `intent.reference` is not sent: Axys carries no result lookup of its own
    // to key on, and applies the change during this call.

    const response = await this.httpClient.request<
      AxysEnvelope<AxysCardLifecycleData>
    >('PUT', `/cards/${providerCardId}/status`, body, idempotencyKey);
    const data = unwrapAxysData(
      'card status update',
      response.status,
      response.body,
    );

    // Always the applied arm — the card is at this status by the time they
    // answer.
    return {
      state: 'APPLIED',
      status: mapAxysCardStatus(data.status),
      operation: data.operation,
      updated: data.updated,
    };
  }

  async updateCardPin(
    providerCardId: string,
    pinChangeRequestId: string,
    oldPin: string,
    newPin: string,
    _credentials: CardProviderCredentials,
    idempotencyKey?: string,
  ): Promise<CardLifecycleOperationResult> {
    const body = {
      pin_change_request_id: pinChangeRequestId,
      old_pin: oldPin,
      new_pin: newPin,
    };

    const response = await this.httpClient.request<
      AxysEnvelope<AxysCardLifecycleData>
    >('PUT', `/cards/${providerCardId}/pin`, body, idempotencyKey);
    const data = unwrapAxysData(
      'card PIN update',
      response.status,
      response.body,
    );

    return {
      state: 'APPLIED',
      status: mapAxysCardStatus(data.status),
      operation: data.operation,
      updated: data.updated,
    };
  }

  async getCardTransactions(
    providerCardId: string,
    params: ListCardTransactionsParams,
    _credentials: CardProviderCredentials,
  ): Promise<CardTransactionsResult> {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.before !== undefined) query.set('before', String(params.before));
    if (params.after !== undefined) query.set('after', String(params.after));
    if (params.cursor) query.set('cursor', params.cursor);

    const queryString = query.toString();
    const path = `/cards/${providerCardId}/transactions${queryString ? `?${queryString}` : ''}`;

    const response = await this.httpClient.request<
      AxysEnvelope<AxysTransactionsData>
    >('GET', path);
    const data = unwrapAxysData(
      'card transactions listing',
      response.status,
      response.body,
    );

    return {
      items: data.items.map((item) => ({
        id: item.id,
        // Converted rather than passed through: Axys names these fields for
        // minor units and the port publishes decimal strings in the currency's
        // own units, so this adapter is where the two meet.
        amount: this.decimalAmount(item.amount_minor, item.currency_code),
        currencyCode: item.currency_code,
        status: item.status,
        category: item.category,
        merchantName: item.merchant_name,
        // Converted in the merchant's own currency, not the card's — a foreign
        // purchase carries both, and shifting the merchant figure by the card
        // currency's exponent would misstate it wherever the two differ.
        merchantAmount:
          item.merchant_amount_minor == null
            ? null
            : this.decimalAmount(
                item.merchant_amount_minor,
                item.merchant_currency ?? item.currency_code,
              ),
        merchantCurrency: item.merchant_currency ?? null,
        createdAt: item.created_at,
        settledAt: item.settled_at,
      })),
      nextCursor: data.next_cursor,
    };
  }

  /**
   * One of Axys's minor-unit figures as a decimal string. A value that is not
   * an integer is passed through unchanged rather than refused, and the
   * reasoning is that it is not minor units in the first place.
   */
  private decimalAmount(amountMinor: string, currencyCode: string): string {
    const amount = axysMinorToDecimal(amountMinor, currencyCode);
    if (amount === null) {
      this.logger.warn(
        `Axys returned "${amountMinor}" as a minor-unit amount on a card transaction, which is not a whole number — publishing it as sent rather than shifting it`,
      );
      return amountMinor;
    }

    return amount;
  }

  /** Axys has no product catalogue. */
  listCardProducts(): Promise<CardProductListing[]> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'listCardProducts',
        'it has no card product catalogue',
      ),
    );
  }

  /** Nothing to quote: a cardholder pays into an address in a coin of their own choosing. */
  quoteCardFunding(): Promise<CardFundingQuoteResult> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'quoteCardFunding',
        'its cards are funded by paying into a deposit address, so it publishes no price for one',
      ),
    );
  }

  /** No account of ours to read: its cards are funded by paying into an address. */
  getMerchantBalance(): Promise<MerchantBalanceResult> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'getMerchantBalance',
        'its cards are funded by paying into a deposit address, so there is no account of ours with the issuer to report a balance for',
      ),
    );
  }

  /** A different funding model, not a missing feature. */
  requestCardDeposit(): Promise<CardDepositRequestResult> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'requestCardDeposit',
        'its cards are funded by paying into a deposit address rather than by a request',
      ),
    );
  }

  /** Nothing here ever asked for a deposit, so there is nothing to look up. */
  getCardDepositResult(): Promise<CardDepositOutcome> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'getCardDepositResult',
        'its cards are funded by paying into a deposit address, so no deposit request exists to report on',
      ),
    );
  }

  /**
   * Applied during the call that asks for one, so nothing is left to report.
   * `OPERATION_RESULT` stays undeclared, keeping the reconcile off its rows.
   */
  getCardOperationResult(): Promise<CardOperationOutcome> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'getCardOperationResult',
        'it carries a lifecycle operation out during the call that requests one, so an operation has no outcome to look up afterwards',
      ),
    );
  }

  /** Axys issues synchronously, so there is no outcome to fetch. */
  getCardApplicationResult(): Promise<CardApplicationOutcome> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'getCardApplicationResult',
        'it issues cards synchronously, so an application has no outcome to look up afterwards',
      ),
    );
  }

  /** Axys answers when asked and posts nothing back, so nothing arrives to read. */
  readCallback(): Promise<CardCallbackReading> {
    return Promise.reject(
      new CardProviderUnsupportedOperationError(
        CardProviderKey.AXYS,
        'readCallback',
        'it sends no asynchronous callbacks, so there is no delivery to verify',
      ),
    );
  }

  /** Nothing calls back, so there is nothing to answer. */
  callbackAck(): { status: number; body: string; contentType: string } {
    throw new CardProviderUnsupportedOperationError(
      CardProviderKey.AXYS,
      'callbackAck',
      'it sends no asynchronous callbacks, so there is no delivery to answer',
    );
  }
}
