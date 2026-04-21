const API_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/;

export function parseApiDateTime(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(API_DATE_TIME_PATTERN);

  if (!match) {
    return new Date(trimmed);
  }

  const [, year, month, day, hour, minute, second = "0", fraction = "0", zulu, sign, offsetHour = "0", offsetMinute = "0"] =
    match;

  const utcMilliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, "0").slice(0, 3)),
  );

  if (zulu || !sign) {
    return new Date(utcMilliseconds);
  }

  const offsetMinutes = Number(offsetHour) * 60 + Number(offsetMinute);
  const signedOffset = sign === "+" ? offsetMinutes : -offsetMinutes;

  return new Date(utcMilliseconds - signedOffset * 60_000);
}

export function normalizeApiDateTime(value: string) {
  const parsed = parseApiDateTime(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function formatLocalDateTime(value: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, options).format(parseApiDateTime(value));
}
