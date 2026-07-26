// RFC 5322 subset for email validation.
// Accepts: local-part@domain with alphanumeric, dot, underscore, percent, plus, hyphen in local;
// alphanumeric, dot, hyphen in domain; TLD must be 2+ letters.
export const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
