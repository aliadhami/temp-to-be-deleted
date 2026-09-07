/** Formats a Date as MLT's required ddMMyyyy HH:mm:ss, in UTC. */
export const formatMltTimestamp = (date: Date): string => {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const day = pad(date.getUTCDate());
  const month = pad(date.getUTCMonth() + 1);
  const year = date.getUTCFullYear();
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${day}${month}${year} ${hours}:${minutes}:${seconds}`;
};
