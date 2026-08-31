/**
 * Shared inline form validators for the auth/workspace forms (machine-voice
 * error copy, applied on submit, cleared on change). Pure functions: each
 * returns the error message or null when the value is valid.
 */

const EMAIL_RE = /.+@.+\..+/;
const SLUG_RE = /^[a-z0-9-]+$/;
export const PASSWORD_MIN_LENGTH = 10;
export const SLUG_MAX_LENGTH = 48;

export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (!value) return "Enter your email";
  if (!EMAIL_RE.test(value)) return "Enter a valid email address";
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return "Enter your password";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  return null;
}

export function validateName(name: string, label = "name"): string | null {
  if (!name.trim()) return `Enter your ${label}`;
  return null;
}

export function validateWorkspaceName(name: string): string | null {
  if (!name.trim()) return "Enter a workspace name";
  return null;
}

export function validateWorkspaceSlug(slug: string): string | null {
  const value = slug.trim();
  if (!value) return "Choose a workspace URL";
  if (!SLUG_RE.test(value)) return "Lowercase letters, numbers, and dashes only";
  if (value.length > SLUG_MAX_LENGTH) {
    return `Must be ${SLUG_MAX_LENGTH} characters or fewer`;
  }
  return null;
}
