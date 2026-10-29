import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {projectRoot} from '../src/storage.mjs';
const temp=join(projectRoot,'work','tmp');await mkdir(temp,{recursive:true});
const child=spawn(process.execPath,[join(projectRoot,'node_modules','playwright','cli.js'),'install','chromium'],{stdio:'inherit',windowsHide:true,cwd:projectRoot,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:join(projectRoot,'.browsers'),TMP:temp,TEMP:temp,TMPDIR:temp}});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
