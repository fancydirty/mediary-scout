// RFC 5322 subset for email validation.
// Accepts: local-part@domain with alphanumeric, dot, underscore, percent, plus, hyphen in local;
// alphanumeric, dot, hyphen in domain; TLD must be 2+ letters.
export const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * RFC 5321 §4.5.3.1.3 maximum forward-path length. Check this BEFORE running
 * EMAIL_RE, but AFTER normalizing (trim+lowercase): the regex is happy with an
 * arbitrarily long local-part, so an unauthenticated caller could otherwise
 * hand us a large "address" to scan and then store. Measure the normalized
 * value — capping the raw submission rejects a legitimate 254-char address
 * that arrived with surrounding whitespace.
 */
export const EMAIL_MAX_LENGTH = 254;
