/** The currencies the page offers (web/index.html CURRENCIES, the ones its exchange-rate service supports). Keep the two lists the same.
 *  A currency outside this list would break Settle Up for the whole trip (no exchange rate), so the Worker refuses it. */
export const CURRENCIES: readonly string[] = [
  'AED', 'ALL', 'AMD', 'ARS', 'AUD', 'AZN', 'BDT', 'BGN', 'BHD', 'BND',
  'BOB', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK', 'DZD',
  'EGP', 'ETB', 'EUR', 'GBP', 'GEL', 'GHS', 'HKD', 'HUF', 'IDR', 'ILS',
  'INR', 'IQD', 'ISK', 'JOD', 'JPY', 'KES', 'KHR', 'KRW', 'KWD', 'KZT',
  'LAK', 'LBP', 'LKR', 'MAD', 'MDL', 'MMK', 'MXN', 'MYR', 'NGN', 'NOK',
  'NPR', 'NZD', 'OMR', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD',
  'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
  'UYU', 'VND', 'ZAR',
];
