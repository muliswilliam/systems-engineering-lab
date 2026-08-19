/**
 * faker's name-derived emails collide once enough rows are generated from a
 * finite first/last name space (birthday paradox) - large presets in
 * multiple labs hit this against a `unique` email column. This resolves a
 * collision by appending a numeric suffix to the local part, checking
 * against every email issued so far (including previously suffixed ones) so
 * the result is guaranteed unique. It never calls into faker, so it doesn't
 * shift the RNG sequence for any other generated field.
 */
export function toUniqueEmail(baseEmail: string, usedEmails: Set<string>): string {
  if (!usedEmails.has(baseEmail)) {
    usedEmails.add(baseEmail);
    return baseEmail;
  }

  const atIndex = baseEmail.indexOf("@");
  const local = baseEmail.slice(0, atIndex);
  const domain = baseEmail.slice(atIndex);

  let suffix = 2;
  let candidate = `${local}${suffix}${domain}`;
  while (usedEmails.has(candidate)) {
    suffix += 1;
    candidate = `${local}${suffix}${domain}`;
  }

  usedEmails.add(candidate);
  return candidate;
}
