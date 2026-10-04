import { newId } from '../core/id.js';
import type { FastifyInstance } from 'fastify';
import { analyses, devices, events, lines, log, now, recordings, breakers, substations } from '../domain/state.js';
import { analyzeSequence, classifyFault, locateFault } from '../services/fault-calculator.js';

export async function registerFaultRoutes(app: FastifyInstance) {
  app.post('/api/recordings', async (req: any, res: any) => {
    const b = req.body as any;
    if (!b.name || !b.lineId || !Array.isArray(b.samples)) return res.code(400).send({ error: 'name、lineId、samples 必填' });
    const line = lines.find(x => x.id === b.lineId);
    if (!line) return res.code(404).send({ error: 'line not found' });
    const samples = b.samples;
    if (samples.length === 0) return res.code(400).send({ error: 'samples 不能为空' });
    const times = samples.map((x: any) => Number(x.timeMs));
    if (times.some((t: number) => !Number.isFinite(t))) return res.code(400).send({ error: '样本时间轴无效：timeMs 必须为有限数值' });
    const monotonic = times.every((x: number, i: number) => i === 0 || x >= times[i - 1]);
    if (!monotonic) return res.code(400).send({ error: '样本时间轴无效：timeMs 必须单调不减' });
    const r = { id: newId(), name: b.name, lineId: b.lineId, triggerTimeMs: Number(b.triggerTimeMs ?? Math.min(...times, 0)), sampleRateHz: Number(b.sampleRateHz || 1000), samples, quality: { channels: new Set(samples.map((x: any) => x.channel)).size, monotonic, badCount: samples.filter((x: any) => x.quality === 'bad').length }, createdAt: now(), status: 'captured' };
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
    const b = req.body as any;
    let recording = null;
    if (b.recordingId) {
      recording = recordings.find(x => x.id === b.recordingId);
      if (!recording) return res.code(404).send({ error: 'recording not found' });
      if (recording.lineId !== event.lineId) return res.code(409).send({ error: 'recording line mismatch', recordingLineId: recording.lineId, eventLineId: event.lineId });
    }
    const line = lines.find(x => x.id === event.lineId)!;
    const relay = devices.find(x => x.lineId === line.id);
    const sequence = [{ timeMs: 0, type: 'fault-inception', value: event.fault.apparentImpedanceOhm }, { timeMs: 12, type: 'pickup', deviceId: relay?.id }, { timeMs: 18, type: 'zone-trip', deviceId: relay?.id }, { timeMs: 42, type: 'trip-command', deviceId: relay?.id }, { timeMs: 78, type: 'breaker-open', breakerId: breakers.find(x => x.substation === substations.find(s => s.id === line.from)?.id)?.id }];
    const analysis = { id: newId(), eventId: event.id, recordingId: recording?.id || null, createdAt: now(), fault: event.fault, location: event.location, events: sequence, sourceSampleCount: recording?.samples.length || 0, sequence: analyzeSequence({ events: sequence, fault: { type: b.faultLocation === 'external' ? 'external' : event.fault.type } }), settingsVersion: relay?.settingsVersion };
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
