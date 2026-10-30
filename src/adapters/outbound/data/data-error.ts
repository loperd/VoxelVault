export type DataErrorCode =
  | 'INVALID_DTO'
  | 'INVALID_URL'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'OPERATION_PENDING'
  | 'OPERATION_REJECTED';

/** Which part of the app the failure belongs to; the crash dialog words itself by it. */
export type DataErrorArea = 'wallet' | 'inventory' | 'items';

export class DataError extends Error {
  readonly code: DataErrorCode;
  readonly area?: DataErrorArea;

  constructor(
    code: DataErrorCode,
    message: string,
    options?: ErrorOptions & { area?: DataErrorArea },
  ) {
    super(message, options);
    this.name = 'DataError';
    this.code = code;
    if (options?.area) this.area = options.area;
  }
}
