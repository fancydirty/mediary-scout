// RFC 5322 subset for email validation.
// Accepts: local-part@domain with alphanumeric, dot, underscore, percent, plus, hyphen in local;
// alphanumeric, dot, hyphen in domain; TLD must be 2+ letters.
export const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * RFC 5321 §4.5.3.1.3 maximum forward-path length. Check this BEFORE running
 * EMAIL_RE: the regex is happy with an arbitrarily long local-part, so an
 * unauthenticated caller could otherwise hand us a 200KB "address" to scan and
 * then store.
 */
export const EMAIL_MAX_LENGTH = 254;
