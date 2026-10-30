import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function verifyNormalization(binary = fileURLToPath(new URL("../build/music_core_normalization_contract", import.meta.url))) {
  const cases = [];
  const add = (id, request, check) => cases.push({ id, request, check });
  for (const input of [null, [], "invalid", true, 1, {}, { schemaVersion: 2 }])
    add(`invalid bundle ${JSON.stringify(input)}`, { operation:"normalizeBundle", input }, value => {
      assert.equal(value.schemaVersion, 1); assert.deepEqual(value.instrumentProfiles, {}); assert.deepEqual(value.voicingSeeds, {});
    });
  const saved = {
    schemaVersion:1, bundleId:" saved ", version:" 1.0 ",
    harmonicDefinitions:{major:{id:"major",label:"Major",suffix:"",aliases:["maj"],tones:[{degree:"1",interval:0},{degree:"3",interval:4},{degree:"5",interval:7}]}},
    instrumentProfiles:{custom:{id:"custom",label:"Custom",family:"fretted",executionLayer:"fretboard",tuning:[{string:1,openPitch:"E4"}],fretboard:{frets:22,stringOrder:[6,5,4,3,2,1],canCapo:true,canRetune:false}}},
    voicingSeeds:{custom:{common:[{id:"saved-c-open",instrumentId:"custom",label:"Saved C",chordLabel:"C",rank:1,source:"first-party",notes:[{string:1,fret:0,finger:1}]}],moveableDefinitions:[]}}, importAdapters:{saved:{schemaVersion:1,stringOrder:[6,5,4,3,2,1]}},
  };
  add("valid saved identifiers and positions survive", {operation:"normalizeBundle",input:saved}, value => {
    assert.equal(value.bundleId,"saved"); assert.equal(value.version,"1.0");
    assert.deepEqual(value.harmonicDefinitions,saved.harmonicDefinitions);
    assert.deepEqual(value.instrumentProfiles,saved.instrumentProfiles);
    assert.deepEqual(value.voicingSeeds,saved.voicingSeeds); assert.deepEqual(value.importAdapters,saved.importAdapters);
  });
  for (const invalid of [-1,0,1.5,"1",null,Infinity]) {
    const input=structuredClone(saved); input.instrumentProfiles.custom.fretboard.frets=invalid;
    add(`invalid positive dimension ${invalid}`, {operation:"normalizeBundle",input}, value => assert.equal(value.instrumentProfiles.custom.fretboard,undefined));
  }
  for (const order of [[],[6,5,4],[6,5,4,3,2,2],[6,5,4,3,2,9],[6,5,4,3,2,"1"]]) {
    const input=structuredClone(saved); input.instrumentProfiles.custom.fretboard.stringOrder=order;
    add(`invalid string order ${JSON.stringify(order)}`, {operation:"normalizeBundle",input}, value => assert.deepEqual(value.instrumentProfiles.custom.fretboard.stringOrder,[]));
  }
  for (const degree of ["1","#1","b3","#4","bb7","7"]) {
    const input=structuredClone(saved); input.harmonicDefinitions.major.tones=[{degree,interval:9}];
    add(`formal degree ${degree}`, {operation:"normalizeBundle",input}, value => assert.deepEqual(value.harmonicDefinitions.major.tones,[{degree,interval:9}]));
  }
  add("invalid tones are filtered without inventing a quality",{operation:"normalizeBundle",input:{schemaVersion:1,harmonicDefinitions:{bad:{label:"Bad",suffix:"?",tones:[{degree:"unknown",interval:4},{degree:"1",interval:1.5}]}}}},value=>assert.deepEqual(value.harmonicDefinitions,{}));
  add("Unicode saved labels are trimmed and preserved", {operation:"normalizeBundle",input:{schemaVersion:1,bundleId:"\u2000saved 🎵\u00a0",version:"\ufeff1\u3000"}}, value=>{assert.equal(value.bundleId,"saved 🎵");assert.equal(value.version,"1");});
  add("prototype keys cannot become executable object structure", {operation:"normalizeBundle",input:JSON.parse('{"schemaVersion":1,"harmonicDefinitions":{"__proto__":{"label":"Bad","suffix":"","tones":[{"degree":"1","interval":0}]}}}')},value=>assert.deepEqual(value.harmonicDefinitions,{}));
  add("observed import preserves provenance and position identity",{operation:"normalizeObserved",input:{" C ":[{positions:["x","3","2","0","1","0"],fingerings:[[0,3,2,0,1,0]]}]},options:{sourceId:"synthetic",instrumentId:"guitar",rankStart:42}},value=>{
    assert.equal(value.length,1);assert.equal(value[0].id,"synthetic-c-1");assert.equal(value[0].source,"observed-gzip");assert.equal(value[0].rank,42);
    assert.deepEqual(value[0].notes.map(n=>[n.string,n.fret]),[[5,3],[4,2],[3,0],[2,1],[1,0]]);
  });
  add("malformed observed shapes remain absent",{operation:"normalizeObserved",input:{C:[null,{positions:[1,2]},{positions:"invalid"}]}},value=>assert.deepEqual(value,[]));
  const result=spawnSync(Array.isArray(binary)?binary[0]:binary,Array.isArray(binary)?binary.slice(1):[],{input:cases.map(c=>JSON.stringify(c.request)).join("\n")+"\n",encoding:"utf8",maxBuffer:32*1024*1024});
  assert.equal(result.status,0,result.stderr||String(result.error));
  const rows=result.stdout.trim().split("\n").map(line=>JSON.parse(line));assert.equal(rows.length,cases.length);
  cases.forEach((c,i)=>{try{c.check(rows[i]);}catch(error){throw new Error(c.id+": "+error.message,{cause:error});}});
  return {namedNormalizationContracts:cases.length};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(verifyNormalization(),null,2));
