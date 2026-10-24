export function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasMaxLength(value: unknown, maxLength: number): boolean {
  return typeof value === "string" && value.length <= maxLength;
}
