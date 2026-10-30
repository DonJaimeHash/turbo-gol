// Account fixtures for the server tests (the sign-in design's §8, PR 5). An account is made the way
// the game makes one without a password, through a provider identity (AccountStore.oauth), so the
// tests that only need "an account" no longer depend on username-and-password sign-up
// (AccountStore.register), which the email accounts replace.
//
//   makeAccount(store, name, { email?, provider?, now?, refresh? }) -> the UserRef of a new account
//
// It runs on any AccountStore: a node:sqlite one, or a real AccountsDO's `obj.store`.

let refreshes = 0;

/** A refresh token hash no other fixture uses (64 hex characters). */
export function fixtureRefresh() {
  return (++refreshes).toString(16).padStart(64, 'f');
}

/**
 * A new account named `name`, signed in once with `provider` ('google' by default, or 'discord';
 * its identity is 'g-<name>' or 'd-<name>'). `email`: a verified address (proof 'mail', as a code
 * or a link of ours sets it). `now`: when it was created and signed in. `refresh`: the hash of its
 * first refresh token (a fresh one by default). Throws instead of renaming: a name that is taken or
 * not a username (AccountStore.oauth would add digits) is a mistake in the test.
 */
export function makeAccount(store, name, { email, provider = 'google', now = Date.now(), refresh = fixtureRefresh() } = {}) {
  if (provider !== 'google' && provider !== 'discord') throw new Error(`makeAccount: provider ${provider}`);
  const r = store.oauth(provider, (provider === 'google' ? 'g-' : 'd-') + name, name, null, refresh, now);
  if (typeof r === 'string') throw new Error(`makeAccount(${name}): ${r}`);
  if (!r.created || r.username !== name) throw new Error(`makeAccount(${name}): ${r.created ? 'named ' + r.username : 'that identity has an account'}`);
  if (email !== undefined) {
    const c = store.claimEmail(r.userId, email, 'mail', now);
    if (c !== 'ok') throw new Error(`makeAccount(${name}): email ${c}`);
  }
  return r;
}
