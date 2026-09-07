export interface AxysAccountData {
  id: string;
  status: string;
  kyc_url: string | null;
  kyc_generation?: string | null;
  kyc_revision?: string | null;
}

export interface AxysCardData {
  id: string;
  account_id?: string;
  card_type?: string;
  status: string;
  masked_pan: string;
  currency_code?: string;
}

export interface AxysCardBalance {
  available: string;
  ledger: string;
  currency_code: string;
  observed_at: string;
}

export interface AxysCardDetailData extends AxysCardData {
  balance: AxysCardBalance | null;
}

export interface AxysDepositAddressEntry {
  chain: string;
  address: string;
}

export interface AxysDepositAddressData {
  deposit_addresses: AxysDepositAddressEntry[];
}

export interface AxysActivateData {
  status: string;
  operation?: string;
  updated?: boolean;
}

/** Shared response shape for status update and PIN change — both return the full card plus which operation ran. */
export interface AxysCardLifecycleData {
  id: string;
  account_id: string;
  card_type: string;
  status: string;
  masked_pan: string | null;
  currency_code: string;
  card_display: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  operation: 'activate' | 'block' | 'unblock' | 'update_pin';
  updated: boolean;
}

export interface AxysTransactionItem {
  id: string;
  amount_minor: string;
  currency_code: string;
  status: string;
  category: string;
  merchant_name: string | null;
  merchant_amount_minor?: string | null;
  merchant_currency?: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface AxysTransactionsData {
  card_id: string;
  items: AxysTransactionItem[];
  next_cursor: string | null;
}

export interface AxysErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AxysEnvelope<T> {
  success: boolean;
  data?: T;
  error?: AxysErrorBody;
  requestId: string;
  timestamp: string;
}

export interface AxysSensitiveCardData {
  id: string;
  masked_pan: string;
  cvv: string;
  expiry_month: number;
  expiry_year: number;
}
