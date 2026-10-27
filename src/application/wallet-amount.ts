const MAX_UNITS = 9223372036854775807n;

function validatePrecision(precision: number): void {
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new Error('Некорректная точность валюты.');
  }
}

export function parseWalletAmount(input: string, precision: number): string {
  validatePrecision(precision);
  const value = input.trim().replace(',', '.');
  if (value.length > 80 || !/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error('Введите положительную сумму.');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > precision) {
    throw new Error(`Допустимо знаков после запятой: ${precision}.`);
  }
  const amount = BigInt(whole + fraction.padEnd(precision, '0'));
  if (amount <= 0n || amount > MAX_UNITS) {
    throw new Error('Сумма вне допустимого диапазона.');
  }
  return amount.toString();
}

export function formatWalletAmount(units: string, precision: number): string {
  validatePrecision(precision);
  if (!/^(0|[1-9]\d*)$/.test(units) || BigInt(units) > MAX_UNITS) {
    throw new Error('Некорректная сумма.');
  }
  const padded = units.padStart(precision + 1, '0');
  const whole = precision === 0 ? padded : padded.slice(0, -precision);
  const formatted = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return precision === 0 ? formatted : `${formatted},${padded.slice(-precision)}`;
}
