import { defineConfig } from '@playwright/test';
import config from './playwright.config';
/** Use the separately provisioned immutable preview/API, never spawn a fixture server. */
export default defineConfig({...config,webServer:undefined,fullyParallel:false,workers:1,testMatch:'midnight-live.spec.ts',outputDir:'/tmp/zkiss-midnight-live-results'});
