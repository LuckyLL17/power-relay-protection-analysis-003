import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { analyses, audits, events, recordings } from '../src/domain/state.js';

const app = await buildApp();
const counts = () => ({ recordings: recordings.length, events: events.length, analyses: analyses.length, audits: audits.length });
const before = counts();

const goodSamples = (line: string) => [
  { timeMs: 0, channel: 'Ia', value: 1.2, unit: 'kA', quality: 'good' },
  { timeMs: 1, channel: 'Ib', value: 1.1, unit: 'kA', quality: 'good' },
  { timeMs: 2, channel: 'Ic', value: 1.3, unit: 'kA', quality: 'bad' },
];

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, name + (extra ? `: ${JSON.stringify(extra)}` : ''));
  pass++;
  console.log(`  PASS ${name}`);
};

// ---------- 录波接入 ----------
console.log('1) 接入：不存在的线路');
let r = await app.inject({ method: 'POST', url: '/api/recordings', payload: { name: '错线录波', lineId: 'L-XY', samples: goodSamples('L-XY') } });
ok('返回 404', r.statusCode === 404, r.payload);
ok('错误码 line-not-found', JSON.parse(r.payload).code === 'line-not-found');
ok('无录波入库/无审计', audits.length === before.audits && recordings.length === before.recordings, counts());

console.log('2) 接入：空样本');
r = await app.inject({ method: 'POST', url: '/api/recordings', payload: { name: '空录波', lineId: 'L-AB', samples: [] } });
ok('返回 422', r.statusCode === 422, r.payload);
ok('错误码 samples-empty', JSON.parse(r.payload).code === 'samples-empty');
ok('无录波入库/无审计', audits.length === before.audits && recordings.length === before.recordings, counts());

console.log('3) 接入：非单调时间轴');
r = await app.inject({ method: 'POST', url: '/api/recordings', payload: {
  name: '时间回退录波', lineId: 'L-AB',
  samples: [{ timeMs: 0, channel: 'Ia', value: 1, unit: 'kA', quality: 'good' }, { timeMs: 5, channel: 'Ia', value: 2, unit: 'kA', quality: 'good' }, { timeMs: 4, channel: 'Ia', value: 1, unit: 'kA', quality: 'good' }],
} });
ok('返回 422', r.statusCode === 422, r.payload);
ok('错误码 invalid-timeline', JSON.parse(r.payload).code === 'invalid-timeline');
ok('无录波入库/无审计', audits.length === before.audits && recordings.length === before.recordings, counts());

console.log('4) 接入：非数值时间轴同样拒绝');
r = await app.inject({ method: 'POST', url: '/api/recordings', payload: { name: '坏时间', lineId: 'L-AB', samples: [{ timeMs: 'soon', channel: 'Ia', value: 1, unit: 'kA', quality: 'good' }] } });
ok('返回 422 invalid-timeline', r.statusCode === 422 && JSON.parse(r.payload).code === 'invalid-timeline', r.payload);

console.log('5) 接入：合法录波（L-AB 与 L-BC 各一，等间隔/相同时间戳均合法）');
r = await app.inject({ method: 'POST', url: '/api/recordings', payload: { name: 'L-AB 录波', lineId: 'L-AB', samples: goodSamples('L-AB') } });
ok('L-AB 录波 200', r.statusCode === 200, r.payload);
const recAB = JSON.parse(r.payload);
r = await app.inject({ method: 'POST', url: '/api/recordings', payload: {
  name: 'L-BC 录波', lineId: 'L-BC',
  samples: [{ timeMs: 0, channel: 'Ia', value: 2, unit: 'kA', quality: 'good' }, { timeMs: 0, channel: 'Ib', value: 2, unit: 'kA', quality: 'good' }, { timeMs: 1, channel: 'Ic', value: 2, unit: 'kA', quality: 'good' }],
} });
ok('L-BC 录波 200（同毫秒多点不算非单调）', r.statusCode === 200, r.payload);
const recBC = JSON.parse(r.payload);
ok('入库两条并写两条 ingest 审计', recordings.length === before.recordings + 2 && audits.filter(a => a.action === 'recording.ingest').length === 2, counts());

// ---------- 故障事件 ----------
r = await app.inject({ method: 'POST', url: '/api/fault-events', payload: { lineId: 'L-AB', type: 'three-phase', currentKa: 12.5 } });
const eventAB = JSON.parse(r.payload);
ok('L-AB 故障事件创建', r.statusCode === 200 && eventAB.status === 'new', r.payload);
r = await app.inject({ method: 'POST', url: '/api/fault-events', payload: { lineId: 'L-BC', type: 'single-line-ground', currentKa: 8.2 } });
const eventBC = JSON.parse(r.payload);
ok('L-BC 故障事件创建', r.statusCode === 200 && eventBC.status === 'new', r.payload);

const replay = (id: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/fault-events/${id}/replay`, payload });

// ---------- 重放：跨线路 ----------
console.log('6) 重放：L-AB 事件挂 L-BC 录波（跨班组串线场景）');
const stateBeforeCross = counts();
r = await replay(eventAB.id, { recordingId: recBC.id });
ok('返回 409', r.statusCode === 409, r.payload);
ok('错误码 recording-line-mismatch', JSON.parse(r.payload).code === 'recording-line-mismatch');
ok('不写 analysis/审计，事件未标记 analyzed',
  counts().analyses === stateBeforeCross.analyses &&
  counts().audits === stateBeforeCross.audits &&
  events.find(e => e.id === eventAB.id)!.status === 'new',
  { now: counts(), stateBeforeCross });

console.log('7) 跨线路失败请求重复一次，结果稳定');
r = await replay(eventAB.id, { recordingId: recBC.id });
ok('仍为 409 同样错误码', r.statusCode === 409 && JSON.parse(r.payload).code === 'recording-line-mismatch', r.payload);
ok('仍无新增 analysis/审计', counts().analyses === stateBeforeCross.analyses && counts().audits === stateBeforeCross.audits, counts());

console.log('8) 重放：不存在的 recordingId');
const stateBeforeMissing = counts();
r = await replay(eventAB.id, { recordingId: '00000000-0000-0000-0000-000000000000' });
ok('返回 404', r.statusCode === 404, r.payload);
ok('错误码 recording-not-found', JSON.parse(r.payload).code === 'recording-not-found');
ok('不写 analysis/审计/状态',
  counts().analyses === stateBeforeMissing.analyses &&
  counts().audits === stateBeforeMissing.audits &&
  events.find(e => e.id === eventAB.id)!.status === 'new', counts());

console.log('9) 不带录波的重放行为保留');
r = await replay(eventAB.id, {});
ok('无录波重放 200', r.statusCode === 200, r.payload);
const aNoRec = JSON.parse(r.payload);
ok('recordingId=null、sourceSampleCount=0', aNoRec.recordingId === null && aNoRec.sourceSampleCount === 0, aNoRec);
ok('事件标记 analyzed、写入审计', events.find(e => e.id === eventAB.id)!.status === 'analyzed' &&
  analyses.some(a => a.id === aNoRec.id) && audits.some(a => a.action === 'fault.replay' && a.entity === aNoRec.id));

// 新事件用于：失败后改用合法同线路录波
r = await app.inject({ method: 'POST', url: '/api/fault-events', payload: { lineId: 'L-BC', type: 'three-phase', currentKa: 9.1 } });
const eventBC2 = JSON.parse(r.payload);

console.log('10) 失败后改用合法同线路录波');
r = await replay(eventBC2.id, { recordingId: recAB.id });
ok('先用 L-AB 录波重放 L-BC 事件 → 409', r.statusCode === 409 && JSON.parse(r.payload).code === 'recording-line-mismatch', r.payload);
ok('事件仍 new', events.find(e => e.id === eventBC2.id)!.status === 'new');
r = await replay(eventBC2.id, { recordingId: recBC.id });
ok('改用 L-BC 同线录波 → 200', r.statusCode === 200, r.payload);
const aFixed = JSON.parse(r.payload);
ok('analysis 绑定正确 recordingId 与真实采样数', aFixed.recordingId === recBC.id && aFixed.sourceSampleCount === recBC.samples.length, aFixed);
ok('事件 analyzed、有 replay 审计', events.find(e => e.id === eventBC2.id)!.status === 'analyzed' &&
  audits.some(a => a.action === 'fault.replay' && a.entity === aFixed.id));
ok('失败尝试未留下 analysis/审计（分析数与审计数各只增加成功部分）',
  analyses.filter(a => a.eventId === eventBC2.id).length === 1,
  analyses.filter(a => a.eventId === eventBC2.id));

console.log('11) 有效路径：L-AB 事件 + L-AB 录波（新事件，因事件 9 已 analyzed 也允许再次重放）');
r = await app.inject({ method: 'POST', url: '/api/fault-events', payload: { lineId: 'L-AB', type: 'three-phase' } });
const eventAB2 = JSON.parse(r.payload);
r = await replay(eventAB2.id, { recordingId: recAB.id });
ok('同线录波重放 200', r.statusCode === 200, r.payload);
const aOK = JSON.parse(r.payload);
ok('recordingId/采样数量正确（3 个采样，含 1 bad）', aOK.recordingId === recAB.id && aOK.sourceSampleCount === 3, aOK);

console.log('12) 审计内容不得包含失败尝试写入的错误 recordingId/采样数');
const replayAudits = audits.filter(a => a.action === 'fault.replay');
ok('所有 replay 审计对应真实成功 analysis', replayAudits.every(a => analyses.some(x => x.id === a.entity)), replayAudits.map(a => a.entity));
ok('没有任何审计携带跨线录波 id', !replayAudits.some(a => a.payload?.recordingId === recBC.id && a.payload?.eventId === eventAB.id));

console.log(`\nALL ${pass} ASSERTIONS PASSED`);
await app.close();
