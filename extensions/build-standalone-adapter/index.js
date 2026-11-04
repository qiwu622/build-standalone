import {getContext} from '/scripts/extensions.js';
import * as openAI from '/scripts/openai.js';
import {installSillyTavern} from './runtime.js?v=0.7.0';

installSillyTavern({getContext,openAI,owner:'legacy'});
