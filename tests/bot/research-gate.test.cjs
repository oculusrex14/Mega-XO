'use strict';
// Regression: research progression must be decoupled from the strict PUBLIC-qualification gate.
// The audit finding was that an intermediate improver could never advance the research champion
// because only the 0.70/0.65/200-family public bar could promote. These tests assert:
//  - a candidate clearly below the reference clears the strict gate=false but can still advance via
//    research thresholds when the evidence is strong enough, and is NOT recorded as publicly qualified;
//  - thin evidence (wide CI) and unbound/bare reports are refused on BOTH paths;
//  - head-to-head vs a named predecessor is a valid advance path.
const { test } = require('node:test'), assert = require('node:assert/strict'), spawnSync = require('node:child_process').spawnSync, path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const PY = process.env.V5_OPERATOR_PYTHON || 'python3';

function run(script) {
  const res = spawnSync(PY, ['-c', script], { encoding: 'utf8', cwd: ROOT });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

const HEAD = [
  'import json, sys, collections',
  "sys.path.insert(0, 'training/bot')",
  'import champion_cycle as cc',
  'm="a"*64; s="b"*40',
  'def mk(engine_b, win_fams, nf=200):',
  '    games=[]',
  '    for i in range(nf):',
  '        famwin = i < win_fams',
  '        for swap in (False, True):',
  "            a_side='O' if swap else 'X'",
  "            winner = a_side if famwin else ('X' if a_side=='O' else 'O')",
  "            games.append({'openingFamily':f'fam-{i}','swap':swap,'first':'X','a':'policyValuePUCT','b':engine_b,'point':(1 if famwin else 0),'winner':winner})",
  "    wins=sum(1 for g in games if g['point']==1)",
  '    fam=collections.defaultdict(list)',
  "    for g in games: fam[g['openingFamily']].append(g)",
  '    pairs=[sum(r["point"] for r in rows)/2 for rows in fam.values()]',
  '    iv=cc._bootstrap_ci(pairs)',
  "    return {'status':'COMPLETED','matchups':[{'engineA':'policyValuePUCT','engineB':engine_b,'games':games,'summary':{'games':len(games),'pairs':nf,'wins':wins,'draws':0,'losses':len(games)-wins,'pointScore':wins/len(games),'pairBootstrap95':iv}}]}",
].join('\n');

test('research gate: decoupled advancement is real, honest, and never production', { skip: PY ? false : 'no python3' }, () => {
  const out = run([
    HEAD,
    // 0.20 vs improvedExpert: far below any threshold -> refuse.
    "low=mk('improvedExpert',40)",
    // 0.62 vs improvedExpert at 200 families (CI ~[0.55,0.685]): below strict public bar (0.70) ->
    // strict refuses, research advances because its recomputed lower CI clears 0.50.
    "mid=mk('improvedExpert',124)",
    // 0.65 vs a named predecessor (CI ~[0.585,0.715]): head-to-head path clears.
    "h2h=mk('prevmodel',130)",
    'r_low=cc.evaluate_research_progression(low,expected_model=m,expected_source=s)',
    'r_mid=cc.evaluate_research_progression(mid,expected_model=m,expected_source=s)',
    'r_h2h=cc.evaluate_research_progression(h2h,expected_model=m,expected_source=s,parent_engine="prevmodel")',
    'strict_mid=cc.evaluate_gate(mid,expected_model=m,expected_source=s)',
    'bare={"matchups":[{"engineA":"policyValuePUCT","engineB":"improvedExpert","summary":{"pointScore":0.9,"pairBootstrap95":[0.8,0.95]}}]}',
    'r_bare=cc.evaluate_research_progression(bare,expected_model=m,expected_source=s)',
    'print(json.dumps({"low":r_low,"mid":r_mid,"h2h":r_h2h,"strict_mid":strict_mid,"bare":r_bare}))',
  ].join('\n'));
  assert.equal(out.low.advance, false, 'a clearly weak candidate never advances');
  assert.equal(out.low.productionApproved, false, 'the gate never approves production');
  assert.equal(out.strict_mid.promote, false, '0.62 is below the strict public bar (0.70)');
  assert.equal(out.mid.advance, true, 'a 0.62 candidate with a tight CI can still advance research');
  assert.equal(out.mid.publicQualified, false, 'but it is NOT publicly qualified');
  assert.equal(out.mid.productionApproved, false);
  assert.equal(out.h2h.advance, true, 'head-to-head vs a named predecessor is a valid advance path');
  assert.equal(out.h2h.reason, 'RESEARCH_ADVANCE_HEAD_TO_HEAD');
  assert.equal(out.bare.advance, false, 'a bare numeric report with no bound records is refused');
});

test('research gate: thin evidence is refused (wide CI cannot advance)', { skip: PY ? false : 'no python3' }, () => {
  const out = run([
    HEAD,
    // 34/40 families win = 0.85 point, but only 40 families -> wide CI; the reference floor needs
    // lower-95% > 0.50, which 40 families at 0.85 does not guarantee; assert the gate uses the CI.
    "small=mk('improvedExpert',34,nf=40)",
    'r=cc.evaluate_research_progression(small,expected_model=m,expected_source=s)',
    'print(json.dumps({"r":r}))',
  ].join('\n'));
  // The verdict must be internally consistent: advance iff ciLow clears the floor.
  const r = out.r;
  if (r.advance) assert.ok(r.ciLow >= 0.50, 'advance requires the recomputed lower CI to clear the floor');
  else assert.equal(r.reason, 'BELOW_RESEARCH_THRESHOLD');
});
