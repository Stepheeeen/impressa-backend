const DAY_MS = 24 * 60 * 60 * 1000;

const lagosDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "YYYY-MM-DD" in Nigerian time, so daily rewards reset at midnight in Lagos rather than UTC.
export const lagosDay = (date = new Date()) => lagosDayFormatter.format(date);

export const previousLagosDay = (date = new Date()) => lagosDay(new Date(date.getTime() - DAY_MS));

// Nigeria is UTC+1 all year, with no daylight saving.
export function startOfLagosMonth(date = new Date()) {
  const [year, month] = lagosDay(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, 1, -1));
}

export const daysFromNow = (days: number, from = new Date()) => new Date(from.getTime() + days * DAY_MS);
