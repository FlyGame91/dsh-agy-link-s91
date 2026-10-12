// Verify the durable primary credential store and report pool corruption.
import { readPrimaryCredential, findDuplicateCredentialIdentities, parseCredentialDoc } from '../src/host/credential-slot.ts'
import { AccountPoolManager } from '../src/host/pool.ts'
import { agyFetch } from '../src/host/net.ts'
import { homedir } from 'node:os'

const pool = new AccountPoolManager()
console.log('pool dir:', pool.dir)

const stored = readPrimaryCredential(pool.dir)
if (!stored) {
  console.log('durable primary store: ABSENT')
} else {
  const doc = parseCredentialDoc(stored.raw)
  let email = '(probe failed)'
  try {
    const res = await agyFetch('https://www.googleapis.com/oauth2/v1/userinfo', {
      headers: { Authorization: 'Bearer ' + doc?.accessToken },
    })
    email = res.ok ? ((await res.json()).email ?? '(none)') : `HTTP ${res.status}`
  } catch (e) {
    email = 'probe failed: ' + (e?.message ?? String(e))
  }
  console.log('durable primary store:')
  console.log('  recorded email :', stored.email)
  console.log('  live identity  :', email)
  console.log('  match          :', stored.email === email ? 'YES' : 'NO — store is stale/wrong')
}

console.log('')
console.log('pool accounts:')
for (const a of pool.getAccounts()) {
  console.log(`  ${(a.alias || a.id).padEnd(28)} ${a.dir ? 'isolated' : 'systemHome'}  ${a.email ?? '(no email)'}`)
}

console.log('')
const dupes = findDuplicateCredentialIdentities(pool.getAccounts(), homedir())
if (dupes.length === 0) {
  console.log('duplicate identities: none')
} else {
  console.log('duplicate identities (login overwritten):')
  for (const d of dupes) console.log('  ', d.locations.join(', '), '->', d.fingerprint.slice(0, 30) + '…')
}
