export type DataErrorCode =
  | 'INVALID_DTO'
  | 'INVALID_URL'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'OPERATION_PENDING'
  | 'OPERATION_REJECTED';

export class DataError extends Error {
  readonly code: DataErrorCode;

  constructor(code: DataErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataError';
    this.code = code;
  }
}
