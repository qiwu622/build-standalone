import {loadConfig} from '../src/storage.mjs';
console.log((await loadConfig()).dataDir);
