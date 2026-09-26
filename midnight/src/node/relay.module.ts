import { createRelay } from './relay.js';
import { readEndpoints, readNetwork } from './env.js';
export default createRelay({network:readNetwork(),endpoints:readEndpoints(),walletSeed:process.env.MIDNIGHT_RELAY_WALLET_SEED,indexerUrl:process.env.MIDNIGHT_BROWSER_INDEXER_URL ?? "/midnight-indexer/api/v3/graphql",indexerWsUrl:process.env.MIDNIGHT_BROWSER_INDEXER_WS_URL ?? "/midnight-indexer/api/v3/graphql/ws"});
