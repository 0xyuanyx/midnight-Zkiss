import type { Pool } from 'pg';
import type { Config } from './config.js';
import { eventChainSchema } from './chain-context.js';

/** One server-owned event for the MVP. Existing deadlines and chain scopes are never overwritten. */
export async function ensureDefaultEvent(pool: Pool, config: Config) {
  if (config.autoCreateEvent === false || config.admissionMode !== 'open') return;
  const explicitScope = config.midnightNetwork || config.midnightContractAddress || config.midnightEventScope;
  const scope = explicitScope ? eventChainSchema.parse({ network: config.midnightNetwork, contractAddress: config.midnightContractAddress, eventScope: config.midnightEventScope }) : config.mode === 'demo' ? { network: 'demo', contractAddress: 'a'.repeat(64), eventScope: 'b'.repeat(64) } : null;
  await pool.query(
    `INSERT INTO events(id,name,join_until,discover_until,chat_until,modes,sns_reveal,midnight_network,midnight_contract_address,midnight_event_scope)
     VALUES($1,'ZKiss',now()+interval '7 days',now()+interval '7 days',now()+interval '7 days','["mutual_like"]',true,$2,$3,$4)
     ON CONFLICT(id) DO NOTHING`,
    [config.defaultEventId ?? 'evt_mvp', scope?.network ?? null, scope?.contractAddress ?? null, scope?.eventScope ?? null],
  );
  if (explicitScope) {
    // Initial setup may happen after first launch; never replace an established scope.
    await pool.query('UPDATE events SET midnight_network=$2,midnight_contract_address=$3,midnight_event_scope=$4 WHERE id=$1 AND midnight_contract_address IS NULL', [config.defaultEventId ?? 'evt_mvp', scope!.network, scope!.contractAddress, scope!.eventScope]);
  }
}
