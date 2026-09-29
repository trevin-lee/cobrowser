/**
 * What an agent does not do on its own, in either browser it drives — the panel's tabs and the
 * human's own Chrome or Firefox (the bridge). One rule, stated once:
 *
 *  - It does not click a button that pays or places an order. The human owns that click,
 *    unless they asked the agent to complete it (allowPayment).
 *  - It does not type a password, one-time code, card number or security code. Saved logins
 *    go in through the vault (fill_credentials), which never shows the agent the secret;
 *    anything else the human types, unless they gave it to the agent (allowCredentials).
 *  - It closes the tabs it opened, not the human's, unless they asked it to (allowHumanTab).
 *
 * The browser extensions run in pages and carry copies of these patterns; a test pins the
 * copies to these, so the two tool families cannot drift apart.
 */

/** Labels of buttons that move money or commit an order. */
export const COMMITTING = /\b(pay\s+now|confirm\s+(payment|order|purchase)|place\s+order|submit\s+payment|send\s+money|transfer\s+now|buy\s+now)\b/i;

/** What a secret field calls itself (its label, name, id, placeholder or autocomplete). OTP
 *  boxes are usually type="text", so type="password" alone is not enough. */
export const CREDENTIAL = /\b(password|passcode|pin|otp|one[-\s]?time|2fa|mfa|security\s+code|verification\s+code|cvv|cvc|card\s+number|ssn|social\s+security)\b/i;

/** Autocomplete tokens that mark a field as a secret whatever it is called. */
export const SECRET_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc', 'cc-exp'];

export function paymentRefusal(label: string): { refused: 'payment'; label: string; needsUserAction: string; why: string } {
  return {
    refused: 'payment',
    label,
    needsUserAction: `the human should click "${label}" themselves; re-issue with allowPayment: true only if they asked you to complete this payment`,
    why: 'This submits a payment or places an order. The human owns that click.',
  };
}

export function humanTabRefusal(tab: string | number): { refused: 'human-tab'; tab: string | number; needsUserAction: string; why: string } {
  return {
    refused: 'human-tab',
    tab,
    needsUserAction: 'the human opened this tab: leave it, or re-issue with allowHumanTab: true only if they asked you to close it',
    why: 'The agent closes the tabs it opened, not the human\'s.',
  };
}

export function credentialRefusal(fields: string[]): { refused: string[]; needsUserAction: string; why: string } {
  return {
    refused: fields,
    needsUserAction: `the human should type ${fields.join(', ')} themselves — or, for a saved login, use fill_credentials, which fills it without showing it to you. Pass allowCredentials: true only for a value the human gave you for this purpose.`,
    why: 'Passwords, one-time codes and card numbers are not typed by the agent.',
  };
}
