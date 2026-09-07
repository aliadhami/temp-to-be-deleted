/**
 * Builds the exact plain-text string MLT's PG expects for SecureHash
 * generation/verification: comma-separated "Field=Value" pairs, in the
 * order given by SignatureFields, skipping any field that is missing or
 * empty. Per spec: field names are case-sensitive, no spaces around commas,
 * and the value used must exactly match what's sent in the request.
 */
export const buildMltSignaturePlainText = (
  fields: Record<string, string | undefined>,
  signatureFieldsCsv: string,
): string =>
  signatureFieldsCsv
    .split(',')
    .map((field) => field.trim())
    .filter((field) => {
      const value = fields[field];
      return value !== undefined && value !== '';
    })
    .map((field) => `${field}=${fields[field]}`)
    .join(',');
