import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { analyses, devices, events, lines, log, now, recordings, breakers, substations } from '../domain/state.js';
import { analyzeSequence, classifyFault, locateFault } from '../services/fault-calculator.js';

// 录波接入时校验统一毫秒时间轴：每个 timeMs 必须为有限数且整体非递减。
// 空样本在调用前单独识别，这里不负责区分空样本。
export function validateTimeline(samples: any[]): { valid: true; times: number[] } | { valid: false; reason: string } {
  const times = samples.map((x: any) => Number(x?.timeMs));
  for (const t of times) {
    if (!Number.isFinite(t)) return { valid: false, reason: 'timeMs 必须为有限数值' };
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) return { valid: false, reason: `时间轴非单调：第 ${i} 点 timeMs 早于前一点` };
  }
  return { valid: true, times };
}

export async function registerFaultRoutes(app: FastifyInstance) {
  app.post('/api/recordings', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b || !b.name || !b.lineId || !Array.isArray(b.samples)) {
      return res.code(400).send({ code: 'invalid-request', error: 'name、lineId、samples 必填' });
    }
    // 接入班组只能给真实存在的线路挂录波，未知线路一律拒绝且不留任何状态。
    const line = lines.find(x => x.id === b.lineId);
    if (!line) {
      return res.code(404).send({ code: 'line-not-found', error: 'line not found', lineId: b.lineId });
    }
    const samples = b.samples;
    if (samples.length === 0) {
      return res.code(422).send({ code: 'samples-empty', error: 'samples 不能为空', lineId: b.lineId });
    }
    const timeline = validateTimeline(samples);
    if (!timeline.valid) {
      return res.code(422).send({ code: 'invalid-timeline', error: timeline.reason, lineId: b.lineId });
    }
    const times = timeline.times;
    const r = {
      id: newId(), name: b.name, lineId: b.lineId,
      triggerTimeMs: Number.isFinite(Number(b.triggerTimeMs)) ? Number(b.triggerTimeMs) : times[0],
      sampleRateHz: Number(b.sampleRateHz || 1000),
      samples,
      quality: {
        channels: new Set(samples.map((x: any) => x.channel)).size,
        monotonic: true,
        badCount: samples.filter((x: any) => x.quality === 'bad').length,
      },
      createdAt: now(), status: 'captured',
    };
    recordings.push(r);
    log('recording.ingest', r.id, r);
    return r;
  });

  app.post('/api/fault-events', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.lineId || !b.type) return res.code(400).send({ error: 'lineId 和 type 必填' });
    const line = lines.find(x => x.id === b.lineId);
    if (!line) return res.code(404).send({ error: 'line not found' });
    const fault = classifyFault(b);
    const event = { id: newId(), lineId: b.lineId, occurredAt: b.occurredAt || now(), fault, location: locateFault(line, fault.apparentImpedanceOhm), source: b.source || 'relay-record', status: 'new' };
    events.push(event);
    log('fault.create', event.id, event);
    return event;
  });

  app.post('/api/fault-events/:id/replay', async (req: any, res: any) => {
    const event = events.find(x => x.id === (req.params as any).id);
    if (!event) return res.code(404).send({ error: 'fault event not found' });
    const b = (req.body as any) ?? {};

    // 重放班组引用录波时，录波必须存在，且录波来源线路必须与故障事件线路一致。
    // 任何来源校验失败都直接返回，不写 analysis、不改事件状态、不写审计，重复失败请求结果稳定。
    let recording: any = null;
    if (b.recordingId != null && b.recordingId !== '') {
      recording = recordings.find(x => x.id === b.recordingId) ?? null;
      if (!recording) {
        return res.code(404).send({ code: 'recording-not-found', error: 'recording not found', recordingId: b.recordingId, eventId: event.id });
      }
      if (recording.lineId !== event.lineId) {
        return res.code(409).send({
          code: 'recording-line-mismatch',
          error: '录波线路与故障事件线路不一致',
          eventId: event.id, eventLineId: event.lineId,
          recordingId: recording.id, recordingLineId: recording.lineId,
        });
      }
    }

    const line = lines.find(x => x.id === event.lineId)!;
    const relay = devices.find(x => x.lineId === line.id);
    const sequence = [
      { timeMs: 0, type: 'fault-inception', value: event.fault.apparentImpedanceOhm },
      { timeMs: 12, type: 'pickup', deviceId: relay?.id },
      { timeMs: 18, type: 'zone-trip', deviceId: relay?.id },
      { timeMs: 42, type: 'trip-command', deviceId: relay?.id },
      { timeMs: 78, type: 'breaker-open', breakerId: breakers.find(x => x.substation === substations.find(s => s.id === line.from)?.id)?.id },
    ];
    const analysis = {
      id: newId(), eventId: event.id,
      recordingId: recording ? recording.id : null,
      createdAt: now(), fault: event.fault, location: event.location, events: sequence,
      sourceSampleCount: recording ? recording.samples.length : 0,
      sequence: analyzeSequence({ events: sequence, fault: { type: b.faultLocation === 'external' ? 'external' : event.fault.type } }),
      settingsVersion: relay?.settingsVersion,
    };
    analyses.push(analysis);
    event.status = 'analyzed';
    log('fault.replay', analysis.id, analysis);
    return analysis;
  });

  app.post('/api/analyses/:id/approve', async (req: any, res: any) => {
    const a = analyses.find(x => x.id === (req.params as any).id);
    if (!a) return res.code(404).send({ error: 'analysis not found' });
    if (a.sequence.missing.length) return res.code(409).send({ error: 'sequence incomplete', missing: a.sequence.missing });
    a.status = 'approved';
    a.approvedBy = (req.body as any)?.approvedBy || 'relay-engineer';
    a.approvedAt = now();
    log('analysis.approve', a.id, a);
    return a;
  });

  app.get('/api/analyses', async (req: any) => analyses.filter(x => !(req.query as any)?.status || x.status === (req.query as any).status));

  app.get('/api/fault-events/:id/trace', async (req: any, res: any) => {
    const e = events.find(x => x.id === (req.params as any).id);
    if (!e) return res.code(404).send({ error: 'fault event not found' });
    return { event: e, analyses: analyses.filter(x => x.eventId === e.id) };
  });
}
