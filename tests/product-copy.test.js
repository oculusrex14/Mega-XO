'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const shipped=[
 'index.html',
 'src/app.js',
 'src/community.js',
 'src/monetization-ui.js',
 'src/party-ui.js'
];
const forbidden=[
 'Board-frame collection archived',
 'V3.5.1 does not sell or unlock decorative board frames',
 'saved for future themes',
 'future theme releases',
 'Future themes will be designed separately',
 'Match history and replays are reserved for a future update',
 'unavailable in this build',
 'online room service is not connected here yet',
 'node server/party-server.js',
 'Rewards are delivered only after server verification',
 'providers are ready',
 'REWARDS NOW. THEMES NEXT.',
 '<title>Mega XO - V3.5.1</title>'
];

test('shipped player UI contains no branch, roadmap or archived-feature commentary',()=>{
 const text=shipped.map(file=>fs.readFileSync(path.join(ROOT,file),'utf8')).join('\n');
 for(const phrase of forbidden)assert.equal(text.includes(phrase),false,'Internal commentary leaked into player UI: '+phrase);
});
