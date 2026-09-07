export interface MltRequestFields {
  MerchantId: string;
  UserId: string;
  Password: string;
  IpAssigned?: string;
  TimeStamp: string;
  SourceApplication?: string;
  SignatureFields: string;
  SecureHash: string;
  RequestCategory: 'sale' | 'authorization';
  RequestType?: string;
  Language: 'EN' | 'AR';
  Version?: string;
  ServiceId?: string;
  ServiceName?: string;
  BankId?: string;
  PaymentChannel: string;
  RequestId: string;
  ReferenceNumber: string;
  Currency: string;
  Amount: string;
  FirstName?: string;
  LastName?: string;
  CustomerAddress?: string;
  CustomerCity?: string;
  CustomerState?: string;
  CustomerCountry?: string;
  CustomerPostalCode?: string;
  CustomerEmail?: string;
  CustomerContactNumber?: string;
  CustomerIPAddress?: string;
  DeviceFingerPrint?: string;
  CallBackUrl: string;
  SubMerchantId?: string;
  EncryptionAlgo: 'AES';
  IsAngularRequestingApp?: 'true' | 'false';
  [key: string]: string | undefined;
}

export type MltCardTransactionStatus =
  'PAID' | 'FAILED' | 'REJECT' | 'CANCEL' | 'ERROR';

export interface MltResponseFields {
  MerchantId: string;
  UserId: string;
  Password: string;
  TimeStamp: string;
  SourceApplication: string;
  SignatureFields: string;
  SecureHash: string;
  PaymentChannel: string;
  RequestId: string;
  ChannelReferenceNumber?: string;
  ReferenceNumber: string;
  Verified: 'Yes' | 'No';
  TransactionStatus: MltCardTransactionStatus;
  ReasonCode: string;
  Message: string;
  Currency: string;
  Amount: string;
  AuthorizationCode?: string;
  [key: string]: string | undefined;
}
